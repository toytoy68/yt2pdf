package fr.yt2pdf;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.InputType;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.util.List;

public class MainActivity extends Activity {

    private EditText urlField, langField;
    private CheckBox tsBox;
    private Button goBtn, openBtn, shareBtn;
    private ProgressBar progress;
    private TextView status;
    private Uri lastPdf;
    private boolean busy = false;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("yt2pdf", MODE_PRIVATE);
        buildUi();
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent != null && Intent.ACTION_SEND.equals(intent.getAction())) {
            String shared = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (shared != null) {
                urlField.setText(shared.trim());
                start();
            }
        }
    }

    // ------------------------------------------------------------ interface

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(20));

        TextView title = new TextView(this);
        title.setText("Transcription YouTube → PDF");
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView help = new TextView(this);
        help.setText("Colle un lien, ou partage directement une vidéo depuis l'appli YouTube.");
        help.setTextColor(Color.GRAY);
        help.setPadding(0, dp(4), 0, dp(16));
        root.addView(help);

        urlField = new EditText(this);
        urlField.setHint("https://youtu.be/…");
        urlField.setSingleLine(true);
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(urlField);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(8), 0, dp(8));
        TextView langLbl = new TextView(this);
        langLbl.setText("Langue : ");
        row.addView(langLbl);
        langField = new EditText(this);
        langField.setText(prefs.getString("lang", "fr"));
        langField.setSingleLine(true);
        langField.setEms(3);
        row.addView(langField);
        tsBox = new CheckBox(this);
        tsBox.setText("Horodatage");
        tsBox.setChecked(prefs.getBoolean("ts", true));
        tsBox.setPadding(dp(8), 0, 0, 0);
        row.addView(tsBox);
        root.addView(row);

        goBtn = new Button(this);
        goBtn.setText("Générer le PDF");
        goBtn.setOnClickListener(v -> start());
        root.addView(goBtn);

        progress = new ProgressBar(this);
        progress.setIndeterminate(true);
        progress.setVisibility(View.GONE);
        progress.setPadding(0, dp(16), 0, 0);
        root.addView(progress);

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, dp(8));
        status.setTextSize(15);
        root.addView(status);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        openBtn = new Button(this);
        openBtn.setText("Ouvrir");
        openBtn.setOnClickListener(v -> openPdf());
        shareBtn = new Button(this);
        shareBtn.setText("Partager");
        shareBtn.setOnClickListener(v -> sharePdf());
        actions.addView(openBtn);
        actions.addView(shareBtn);
        openBtn.setVisibility(View.GONE);
        shareBtn.setVisibility(View.GONE);
        root.addView(actions);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
    }

    // ------------------------------------------------------------ traitement

    private void start() {
        if (busy) return;
        String id = YouTubeTranscript.extractId(urlField.getText().toString());
        if (id == null) {
            status.setTextColor(Color.rgb(196, 48, 43));
            status.setText("Lien YouTube non reconnu.");
            return;
        }
        String lang = langField.getText().toString().trim();
        boolean ts = tsBox.isChecked();
        prefs.edit().putString("lang", lang).putBoolean("ts", ts).apply();

        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(urlField.getWindowToken(), 0);

        busy = true;
        goBtn.setEnabled(false);
        progress.setVisibility(View.VISIBLE);
        openBtn.setVisibility(View.GONE);
        shareBtn.setVisibility(View.GONE);
        status.setTextColor(Color.DKGRAY);
        status.setText("Récupération de la transcription…");

        new Thread(() -> {
            try {
                YouTubeTranscript.Result r = YouTubeTranscript.fetch(id, lang);
                runOnUiThread(() -> status.setText("Création du PDF : " + r.title));
                List<YouTubeTranscript.Segment> blocks = YouTubeTranscript.group(r.segments, 45);
                Uri uri = savePdf(r, blocks, ts);
                runOnUiThread(() -> done(uri, r.title, blocks.size()));
            } catch (Exception e) {
                String msg = e.getMessage() != null ? e.getMessage() : e.toString();
                runOnUiThread(() -> fail(msg));
            }
        }).start();
    }

    private Uri savePdf(YouTubeTranscript.Result r, List<YouTubeTranscript.Segment> blocks,
                        boolean ts) throws Exception {
        String name = r.title.replaceAll("[\\\\/:*?\"<>|]+", "").trim();
        if (name.length() > 80) name = name.substring(0, 80).trim();
        if (name.isEmpty()) name = "transcription";

        ContentResolver cr = getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name + ".pdf");
        v.put(MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("Impossible de créer le fichier dans Téléchargements.");
        try (OutputStream os = cr.openOutputStream(uri)) {
            if (os == null) throw new Exception("Impossible d'écrire le fichier.");
            PdfMaker.write(r, blocks, ts, os);
        } catch (Exception e) {
            cr.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return uri;
    }

    private void done(Uri uri, String title, int paragraphs) {
        busy = false;
        lastPdf = uri;
        goBtn.setEnabled(true);
        progress.setVisibility(View.GONE);
        status.setTextColor(Color.rgb(30, 130, 60));
        status.setText("✓ PDF enregistré dans Téléchargements\n" + title
                + "\n(" + paragraphs + " paragraphes)");
        openBtn.setVisibility(View.VISIBLE);
        shareBtn.setVisibility(View.VISIBLE);
    }

    private void fail(String msg) {
        busy = false;
        goBtn.setEnabled(true);
        progress.setVisibility(View.GONE);
        status.setTextColor(Color.rgb(196, 48, 43));
        status.setText("Échec : " + msg);
    }

    private void openPdf() {
        if (lastPdf == null) return;
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(lastPdf, "application/pdf");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Aucune appli pour lire les PDF.", Toast.LENGTH_LONG).show();
        }
    }

    private void sharePdf() {
        if (lastPdf == null) return;
        Intent i = new Intent(Intent.ACTION_SEND);
        i.setType("application/pdf");
        i.putExtra(Intent.EXTRA_STREAM, lastPdf);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivity(Intent.createChooser(i, "Partager le PDF"));
    }
}
