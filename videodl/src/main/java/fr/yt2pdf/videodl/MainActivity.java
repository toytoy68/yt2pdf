package fr.yt2pdf.videodl;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private EditText urlField;
    private CheckBox audioBox;
    private SharedPreferences prefs;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("videodl", MODE_PRIVATE);
        buildUi();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Pré-remplit avec un lien présent dans le presse-papiers
        if (urlField.getText().length() == 0) {
            ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (cm != null && cm.hasPrimaryClip()) {
                ClipData c = cm.getPrimaryClip();
                if (c != null && c.getItemCount() > 0 && c.getItemAt(0).getText() != null) {
                    String u = DownloadService.extractUrl(c.getItemAt(0).getText().toString());
                    if (u != null) urlField.setText(u);
                }
            }
        }
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(20));

        TextView title = new TextView(this);
        title.setText("Téléchargeur de vidéos");
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView help = new TextView(this);
        help.setText("Dans Chrome : ⋮ → Partager → « Télécharger la vidéo ».\n"
                + "Ou colle un lien ici. La vidéo arrive dans Téléchargements ; "
                + "la progression s'affiche dans les notifications.");
        help.setTextColor(Color.GRAY);
        help.setPadding(0, dp(4), 0, dp(16));
        root.addView(help);

        urlField = new EditText(this);
        urlField.setHint("https://…");
        urlField.setSingleLine(true);
        urlField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        root.addView(urlField);

        audioBox = new CheckBox(this);
        audioBox.setText("Audio seulement (m4a)");
        audioBox.setChecked(prefs.getBoolean("audio", false));
        audioBox.setOnCheckedChangeListener((b, on) -> prefs.edit().putBoolean("audio", on).apply());
        audioBox.setPadding(0, dp(8), 0, dp(8));
        root.addView(audioBox);

        Button go = new Button(this);
        go.setText("Télécharger");
        go.setOnClickListener(v -> {
            String u = DownloadService.extractUrl(urlField.getText().toString());
            if (u == null) {
                Toast.makeText(this, "Lien non reconnu.", Toast.LENGTH_LONG).show();
                return;
            }
            DownloadService.start(this, u, audioBox.isChecked());
            urlField.setText("");
            Toast.makeText(this, "Téléchargement lancé — suivi dans les notifications", Toast.LENGTH_SHORT).show();
        });
        root.addView(go);

        TextView note = new TextView(this);
        note.setText("Qualité : jusqu'à 1080p. Le moteur yt-dlp se met à jour tout seul une fois par jour.");
        note.setTextColor(Color.GRAY);
        note.setTextSize(12);
        note.setPadding(0, dp(16), 0, 0);
        root.addView(note);

        ScrollView sv = new ScrollView(this);
        sv.addView(root);
        setContentView(sv);
    }
}
