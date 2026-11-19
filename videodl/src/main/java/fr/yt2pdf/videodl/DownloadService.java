package fr.yt2pdf.videodl;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Environment;
import android.os.IBinder;
import android.provider.MediaStore;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kotlin.Unit;

/** Télécharge les vidéos une par une avec yt-dlp, en service de premier plan (survit au retour dans Chrome). */
public class DownloadService extends Service {

    private static final String CHANNEL = "downloads";
    private static final int FG_ID = 1;
    private static final String EXTRA_URL = "url", EXTRA_AUDIO = "audio";
    private static final String ACTION_CANCEL = "fr.yt2pdf.videodl.CANCEL";
    private static final Pattern URL = Pattern.compile("https?://\\S+");

    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private NotificationManager nm;
    private volatile String currentId;
    private final AtomicInteger queued = new AtomicInteger();
    private int resultId = 100;
    private boolean engineReady = false;

    public static void start(Context ctx, String url, boolean audio) {
        Intent i = new Intent(ctx, DownloadService.class);
        i.putExtra(EXTRA_URL, url);
        i.putExtra(EXTRA_AUDIO, audio);
        ctx.startForegroundService(i);
    }

    /** Premier lien http(s) d'un texte partagé (Chrome envoie parfois « titre + lien »). */
    public static String extractUrl(String text) {
        if (text == null) return null;
        Matcher m = URL.matcher(text);
        return m.find() ? m.group() : null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Téléchargements",
                NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_CANCEL.equals(intent.getAction())) {
            String id = currentId;
            if (id != null) YoutubeDL.getInstance().destroyProcessById(id);
            return START_NOT_STICKY;
        }
        startForeground(FG_ID, progressNotif("Préparation…", "", -1),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        if (intent == null || intent.getStringExtra(EXTRA_URL) == null) {
            stopSelfResult(startId);
            return START_NOT_STICKY;
        }
        String url = intent.getStringExtra(EXTRA_URL);
        boolean audio = intent.getBooleanExtra(EXTRA_AUDIO, false);
        queued.incrementAndGet();
        worker.execute(() -> {
            try {
                run(url, audio);
            } finally {
                queued.decrementAndGet();
                stopSelfResult(startId);   // s'arrête seulement si c'était la dernière demande
            }
        });
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        worker.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ------------------------------------------------------------ téléchargement

    private void ensureEngine() throws Exception {
        if (engineReady) return;
        updateFg("Préparation du moteur…", "Premier lancement : quelques secondes", -1);
        YoutubeDL.getInstance().init(getApplicationContext());
        FFmpeg.getInstance().init(getApplicationContext());
        engineReady = true;

        // Les sites changent souvent : on met yt-dlp à jour au plus une fois par jour
        SharedPreferences p = getSharedPreferences("videodl", MODE_PRIVATE);
        long last = p.getLong("lastUpdate", 0);
        if (System.currentTimeMillis() - last > 24L * 3600 * 1000) {
            updateFg("Mise à jour de yt-dlp…", "", -1);
            try {
                YoutubeDL.getInstance().updateYoutubeDL(getApplicationContext(),
                        YoutubeDL.UpdateChannel._STABLE);
                p.edit().putLong("lastUpdate", System.currentTimeMillis()).apply();
            } catch (Exception ignored) {
                // pas bloquant : on tente avec la version embarquée
            }
        }
    }

    private void run(String url, boolean audio) {
        String id = "dl-" + System.currentTimeMillis();
        File dir = new File(getCacheDir(), id);
        try {
            ensureEngine();
            dir.mkdirs();
            updateFg("Analyse de la page…", url, -1);

            YoutubeDLRequest req = new YoutubeDLRequest(url);
            req.addOption("--no-playlist");
            req.addOption("--no-mtime");
            req.addOption("-o", dir.getAbsolutePath() + "/%(title).150B.%(ext)s");
            if (audio) {
                req.addOption("-f", "ba[ext=m4a]/ba/b");
                req.addOption("-x");
                req.addOption("--audio-format", "m4a");
            } else {
                // jusqu'à 1080p, en privilégiant MP4/M4A (lisible partout), fusion via ffmpeg
                req.addOption("-S", "res:1080,ext:mp4:m4a");
                req.addOption("--merge-output-format", "mp4");
            }

            currentId = id;
            final long[] lastTick = {0};
            YoutubeDL.getInstance().execute(req, id, (progress, eta, line) -> {
                long now = System.currentTimeMillis();
                if (now - lastTick[0] > 700) {
                    lastTick[0] = now;
                    int pct = Math.max(0, Math.min(100, Math.round(progress)));
                    String sub = pct + " %" + (eta > 0 ? " — reste " + fmtEta(eta) : "");
                    int q = queued.get();
                    updateFg(q > 1 ? "Téléchargement (" + (q - 1) + " en attente)" : "Téléchargement…",
                            sub, pct);
                }
                return Unit.INSTANCE;
            });
            currentId = null;

            File out = biggestFile(dir);
            if (out == null) throw new Exception("Aucun fichier produit.");
            updateFg("Enregistrement…", out.getName(), -1);
            Uri uri = saveToDownloads(out);
            notifyDone(out.getName(), uri);
        } catch (YoutubeDL.CanceledException e) {
            notifyMsg("Téléchargement annulé", url, null);
        } catch (Exception e) {
            notifyMsg("Échec du téléchargement", errorLine(e), null);
        } finally {
            currentId = null;
            deleteRec(dir);
        }
    }

    private static File biggestFile(File dir) {
        File best = null;
        File[] fs = dir.listFiles();
        if (fs == null) return null;
        for (File f : fs) {
            String n = f.getName();
            if (!f.isFile() || n.endsWith(".part") || n.endsWith(".ytdl")) continue;
            if (best == null || f.length() > best.length()) best = f;
        }
        return best;
    }

    private Uri saveToDownloads(File f) throws Exception {
        String name = f.getName();
        String mime = mimeOf(name);
        ContentResolver cr = getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("Impossible de créer le fichier dans Téléchargements.");
        try (InputStream in = new FileInputStream(f); OutputStream os = cr.openOutputStream(uri)) {
            if (os == null) throw new Exception("Impossible d'écrire le fichier.");
            byte[] buf = new byte[1 << 16];
            int r;
            while ((r = in.read(buf)) > 0) os.write(buf, 0, r);
        } catch (Exception e) {
            cr.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return uri;
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".mp4")) return "video/mp4";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".m4a")) return "audio/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".opus") || n.endsWith(".ogg")) return "audio/ogg";
        return "application/octet-stream";
    }

    /** Garde la ligne « ERROR: … » de yt-dlp, plus parlante que la trace complète. */
    private static String errorLine(Exception e) {
        String m = e.getMessage() != null ? e.getMessage() : e.toString();
        for (String l : m.split("\n")) {
            if (l.startsWith("ERROR:")) return l.substring(6).trim();
        }
        String t = m.trim();
        int nl = t.lastIndexOf('\n');
        return nl >= 0 ? t.substring(nl + 1) : t;
    }

    private static String fmtEta(long s) {
        return s >= 60 ? (s / 60) + " min " + (s % 60) + " s" : s + " s";
    }

    private static void deleteRec(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File c : fs) deleteRec(c);
        f.delete();
    }

    // ------------------------------------------------------------ notifications

    private Notification progressNotif(String title, String text, int pct) {
        Intent cancel = new Intent(this, DownloadService.class).setAction(ACTION_CANCEL);
        PendingIntent pc = PendingIntent.getService(this, 0, cancel,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle(title)
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, "Annuler", pc).build());
        if (pct >= 0) b.setProgress(100, pct, false); else b.setProgress(0, 0, true);
        return b.build();
    }

    private void updateFg(String title, String text, int pct) {
        nm.notify(FG_ID, progressNotif(title, text, pct));
    }

    private void notifyDone(String name, Uri uri) {
        Intent view = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mimeOf(name))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, resultId, view, PendingIntent.FLAG_IMMUTABLE);
        notifyMsg("✓ Enregistré dans Téléchargements", name, pi);
    }

    private void notifyMsg(String title, String text, PendingIntent tap) {
        Notification.Builder b = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setAutoCancel(true);
        if (tap != null) b.setContentIntent(tap);
        nm.notify(resultId++, b.build());
    }
}
