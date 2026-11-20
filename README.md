# YT → PDF

Application Android qui récupère la transcription d'une vidéo YouTube et l'enregistre en PDF dans Téléchargements.

- Depuis YouTube : **Partager → « Transcription → PDF »**
- Ou coller un lien dans l'appli
- Android 10 minimum

L'APK est compilé automatiquement par GitHub Actions à chaque push et publié dans **Releases**.

## Extension Chrome (Windows / Mac / Linux)

Dossier `chrome-extension/`. Sur une vidéo YouTube, clique sur l'icône **YT → PDF** (ou `Alt+Maj+P`) puis **Générer le PDF** : le fichier arrive dans Téléchargements.

Installation :
1. Télécharger `yt2pdf-chrome.zip` depuis **Releases** et le décompresser dans un dossier qui ne bougera plus.
2. Ouvrir `chrome://extensions`, activer le **Mode développeur** (en haut à droite).
3. **Charger l'extension non empaquetée** → choisir le dossier décompressé.

Police DejaVu Sans incluse (licence libre, voir `fonts/LICENSE-DejaVu.txt`), PDF généré avec jsPDF (MIT).

---

# Vidéo DL (module `videodl`)

Seconde application : télécharge la vidéo d'une page web (YouTube et la plupart des sites) grâce à yt-dlp embarqué.

- Depuis Chrome : **⋮ → Partager → « Télécharger la vidéo »** — le téléchargement tourne en arrière-plan, la progression est dans les notifications
- Ou coller un lien dans l'appli ; option « Audio seulement (m4a) »
- Qualité jusqu'à 1080p, fichier enregistré dans **Téléchargements**
- yt-dlp se met à jour automatiquement une fois par jour
- Android 10 minimum, téléphones ARM

APK : `videodl.apk` dans la même Release que `yt2pdf.apk`.

## Extension Chrome Vidéo DL (Windows / Mac / Linux)

Dossier `chrome-video-dl/`. Lance la vidéo dans Chrome : l'icône **Vidéo DL** affiche un badge avec le nombre de vidéos détectées. Clique dessus puis **Télécharger** : le fichier arrive dans Téléchargements (MP4 ; les flux HLS sont assemblés et convertis en MP4 dans le navigateur).

Installation : comme ci-dessus, avec `videodl-chrome.zip`.

Limites : pas de vidéos protégées par DRM (Netflix, etc.) ; YouTube n'est pas pris en charge par l'extension (flux découpés et chiffrés). Conversion MP4 avec mux.js (Apache-2.0).
