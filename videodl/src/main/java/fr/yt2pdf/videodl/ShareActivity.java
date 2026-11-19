package fr.yt2pdf.videodl;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

/** Reçoit un lien partagé (Chrome → Partager), lance le téléchargement en arrière-plan et se ferme. */
public class ShareActivity extends Activity {

    private String url;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent in = getIntent();
        url = in == null ? null : DownloadService.extractUrl(in.getStringExtra(Intent.EXTRA_TEXT));
        if (url == null) {
            Toast.makeText(this, "Aucun lien trouvé dans le partage.", Toast.LENGTH_LONG).show();
            finish();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            // Les notifications servent à suivre la progression : on les demande une fois
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        } else {
            launch();
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        launch();
    }

    private void launch() {
        boolean audio = getSharedPreferences("videodl", MODE_PRIVATE).getBoolean("audio", false);
        DownloadService.start(this, url, audio);
        Toast.makeText(this, "Téléchargement lancé — suivi dans les notifications", Toast.LENGTH_SHORT).show();
        finish();
    }
}
