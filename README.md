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
