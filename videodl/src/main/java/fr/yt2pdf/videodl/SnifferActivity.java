package fr.yt2pdf.videodl;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Détection universelle : ouvre la page dans un navigateur intégré, l'utilisateur lance la lecture,
 * et on capte les flux vidéo (.m3u8 / .mp4 / .mpd…) demandés par le lecteur du site.
 */
public class SnifferActivity extends Activity {

    private static final String EXTRA_URL = "url";
    private static final Pattern MEDIA = Pattern.compile(
            "\\.(m3u8|mpd|mp4|webm|m4v|mov|mkv)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern HEIGHT = Pattern.compile("(?<![0-9])(2160|1440|1080|720|480|360|240)[pP]?(?![0-9])");

    private WebView web;
    private Button grabBtn;
    private TextView info;
    private final LinkedHashSet<String> found = new LinkedHashSet<>();

    public static Intent intent(Context ctx, String url) {
        return new Intent(ctx, SnifferActivity.class).putExtra(EXTRA_URL, url);
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String url = getIntent().getStringExtra(EXTRA_URL);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        info = new TextView(this);
        info.setText("Lance la lecture de la vidéo : elle sera détectée automatiquement.");
        info.setPadding(dp(12), dp(8), dp(12), dp(8));
        info.setBackgroundColor(Color.rgb(232, 240, 252));
        root.addView(info);

        web = new WebView(this);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1f));

        grabBtn = new Button(this);
        grabBtn.setText("Aucune vidéo détectée");
        grabBtn.setEnabled(false);
        grabBtn.setTypeface(Typeface.DEFAULT_BOLD);
        grabBtn.setGravity(Gravity.CENTER);
        grabBtn.setOnClickListener(v -> choose());
        root.addView(grabBtn);

        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);   // les pubs « nouvelle fenêtre » restent bloquées
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                String scheme = req.getUrl().getScheme();
                return scheme == null || !(scheme.equals("http") || scheme.equals("https"));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                inspect(req.getUrl());
                return null;   // on laisse passer la requête, on observe seulement
            }
        });
        if (url != null) web.loadUrl(url);
    }

    private void inspect(Uri u) {
        String path = u.getPath();
        if (path == null || !MEDIA.matcher(path).find()) return;
        String s = u.toString();
        String low = s.toLowerCase(Locale.ROOT);
        // aperçus au survol des miniatures, pubs : on écarte
        if (low.contains("preview") || low.contains("thumb") || low.contains("/ads") || low.contains("vast")) return;
        // segments HLS isolés inutiles si on a la playlist
        if (low.endsWith(".ts")) return;
        runOnUiThread(() -> {
            if (found.add(s)) {
                int n = found.size();
                grabBtn.setEnabled(true);
                grabBtn.setText(n == 1 ? "Télécharger la vidéo détectée" : "Télécharger (" + n + " flux détectés)");
                info.setText("Vidéo détectée ✓ — tu peux télécharger.");
            }
        });
    }

    private static int height(String s) {
        Matcher m = HEIGHT.matcher(s);
        int best = 0;
        while (m.find()) best = Math.max(best, Integer.parseInt(m.group(1)));
        return best;
    }

    /** Playlists d'abord (elles contiennent toutes les qualités), puis la meilleure définition. */
    private List<String> ranked() {
        List<String> l = new ArrayList<>(found);
        l.sort((a, b) -> {
            boolean pa = isPlaylist(a), pb = isPlaylist(b);
            if (pa != pb) return pa ? -1 : 1;
            boolean ma = a.toLowerCase(Locale.ROOT).contains("master"), mb = b.toLowerCase(Locale.ROOT).contains("master");
            if (ma != mb) return ma ? -1 : 1;
            return Integer.compare(height(b), height(a));
        });
        return l;
    }

    private static boolean isPlaylist(String s) {
        String p = Uri.parse(s).getPath();
        p = p == null ? "" : p.toLowerCase(Locale.ROOT);
        return p.endsWith(".m3u8") || p.endsWith(".mpd");
    }

    private static String label(String s) {
        Uri u = Uri.parse(s);
        String p = u.getPath() == null ? "" : u.getPath();
        String ext = p.substring(p.lastIndexOf('.') + 1).toUpperCase(Locale.ROOT);
        String kind = ext.equals("M3U8") ? "Flux HLS" : ext.equals("MPD") ? "Flux DASH" : "Fichier " + ext;
        int h = height(s);
        String name = p.substring(p.lastIndexOf('/') + 1);
        if (name.length() > 40) name = "…" + name.substring(name.length() - 40);
        return kind + (h > 0 ? " · " + h + "p" : "") + "\n" + u.getHost() + " / " + name;
    }

    private void choose() {
        List<String> l = ranked();
        if (l.size() == 1) { grab(l.get(0)); return; }
        String[] labels = new String[l.size()];
        for (int i = 0; i < l.size(); i++) labels[i] = (i == 0 ? "★ " : "") + label(l.get(i));
        new AlertDialog.Builder(this)
                .setTitle("Choisis le flux (★ = recommandé)")
                .setItems(labels, (d, which) -> grab(l.get(which)))
                .show();
    }

    private void grab(String media) {
        String page = web.getUrl();
        String cookies = CookieManager.getInstance().getCookie(media);
        String pageCookies = page == null ? null : CookieManager.getInstance().getCookie(page);
        DownloadService.Job job = new DownloadService.Job(media, getSharedPreferences("videodl", MODE_PRIVATE).getBoolean("audio", false));
        job.referer = page;
        job.userAgent = web.getSettings().getUserAgentString();
        job.cookies = cookies != null ? cookies : pageCookies;
        job.title = web.getTitle();
        job.direct = true;
        DownloadService.start(this, job);
        Toast.makeText(this, "Téléchargement lancé — suivi dans les notifications", Toast.LENGTH_SHORT).show();
        finish();
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        web.stopLoading();
        web.destroy();
        super.onDestroy();
    }
}
