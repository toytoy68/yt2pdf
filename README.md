# YT → PDF

Application Android qui récupère la transcription d'une vidéo YouTube et l'enregistre en PDF dans Téléchargements.

- Depuis YouTube : **Partager → « Transcription → PDF »**
- Ou coller un lien dans l'appli
- Android 10 minimum

L'APK est compilé automatiquement par GitHub Actions à chaque push et publié dans **Releases**.

---

# Vidéo DL (module `videodl`)

Seconde application : télécharge la vidéo d'une page web (YouTube et la plupart des sites) grâce à yt-dlp embarqué.

- Depuis Chrome : **⋮ → Partager → « Télécharger la vidéo »** — le téléchargement tourne en arrière-plan, la progression est dans les notifications
- Ou coller un lien dans l'appli ; option « Audio seulement (m4a) »
- Qualité jusqu'à 1080p, fichier enregistré dans **Téléchargements**
- yt-dlp se met à jour automatiquement une fois par jour
- Android 10 minimum, téléphones ARM

APK : `videodl.apk` dans la même Release que `yt2pdf.apk`.
