package fr.yt2pdf;

import android.text.Html;
import android.util.Xml;

import org.json.JSONArray;
import org.json.JSONObject;
import org.xmlpull.v1.XmlPullParser;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Récupère la transcription d'une vidéo YouTube via l'API interne (client ANDROID). */
public class YouTubeTranscript {

    private static final String API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
    private static final String CLIENT_VERSION = "20.10.38";
    private static final String UA =
            "com.google.android.youtube/" + CLIENT_VERSION + " (Linux; U; Android 14) gzip";

    public static class Segment {
        public final double start, duration;
        public final String text;
        Segment(double s, double d, String t) { start = s; duration = d; text = t; }
    }

    public static class Result {
        public String videoId, title, author, language;
        public boolean auto;
        public List<Segment> segments = new ArrayList<>();
    }

    private static final Pattern ID_IN_URL = Pattern.compile(
            "(?:v=|youtu\\.be/|/shorts/|/embed/|/live/|/v/)([A-Za-z0-9_-]{11})");
    private static final Pattern BARE_ID = Pattern.compile("^[A-Za-z0-9_-]{11}$");

    /** Trouve l'identifiant dans une URL ou un texte partagé. */
    public static String extractId(String input) {
        if (input == null) return null;
        String s = input.trim();
        if (BARE_ID.matcher(s).matches()) return s;
        Matcher m = ID_IN_URL.matcher(s);
        return m.find() ? m.group(1) : null;
    }

    public static Result fetch(String videoId, String prefLang) throws IOException {
        if (prefLang == null || prefLang.trim().isEmpty()) prefLang = "fr";
        prefLang = prefLang.trim().toLowerCase();

        JSONObject player;
        try {
            JSONObject client = new JSONObject()
                    .put("clientName", "ANDROID")
                    .put("clientVersion", CLIENT_VERSION)
                    .put("androidSdkVersion", 34)
                    .put("hl", prefLang);
            JSONObject body = new JSONObject()
                    .put("context", new JSONObject().put("client", client))
                    .put("videoId", videoId);
            String resp = post("https://www.youtube.com/youtubei/v1/player?key="
                    + API_KEY + "&prettyPrint=false", body.toString());
            player = new JSONObject(resp);
        } catch (org.json.JSONException e) {
            throw new IOException("Réponse YouTube illisible", e);
        }

        Result r = new Result();
        r.videoId = videoId;
        JSONObject details = player.optJSONObject("videoDetails");
        r.title = details != null ? details.optString("title", "Vidéo " + videoId) : "Vidéo " + videoId;
        r.author = details != null ? details.optString("author", "") : "";

        JSONObject captions = player.optJSONObject("captions");
        JSONArray tracks = captions == null ? null : captions
                .optJSONObject("playerCaptionsTracklistRenderer") == null ? null
                : captions.optJSONObject("playerCaptionsTracklistRenderer").optJSONArray("captionTracks");

        if (tracks == null || tracks.length() == 0) {
            JSONObject ps = player.optJSONObject("playabilityStatus");
            String status = ps != null ? ps.optString("status", "") : "";
            if (!"OK".equals(status) && ps != null) {
                throw new IOException("Vidéo inaccessible : " + ps.optString("reason", status));
            }
            throw new IOException("Cette vidéo n'a pas de sous-titres.");
        }

        // Ordre de préférence : manuel langue préférée, auto langue préférée,
        // manuel anglais, auto anglais, puis n'importe lequel traduit.
        JSONObject chosen = null;
        String[][] order = {{prefLang, "manual"}, {prefLang, "asr"}, {"en", "manual"}, {"en", "asr"}};
        for (String[] o : order) {
            chosen = findTrack(tracks, o[0], "asr".equals(o[1]));
            if (chosen != null) break;
        }
        // Ni la langue préférée ni l'anglais : première piste, traduite si possible.
        boolean translate = false;
        if (chosen == null) {
            chosen = tracks.optJSONObject(0);
            translate = chosen.optBoolean("isTranslatable", false);
        }

        String url = chosen.optString("baseUrl").replace("&fmt=srv3", "");
        if (translate) url += "&tlang=" + prefLang;
        r.auto = "asr".equals(chosen.optString("kind"));
        r.language = trackName(chosen) + (translate ? " → traduit (" + prefLang + ")" : "");

        String xml = get(url);
        if (xml.trim().isEmpty()) {
            throw new IOException("YouTube a renvoyé une transcription vide (réessaie plus tard).");
        }
        r.segments = parseXml(xml);
        if (r.segments.isEmpty()) throw new IOException("Transcription vide.");
        return r;
    }

    private static JSONObject findTrack(JSONArray tracks, String lang, boolean asr) {
        for (int i = 0; i < tracks.length(); i++) {
            JSONObject t = tracks.optJSONObject(i);
            if (t == null) continue;
            boolean isAsr = "asr".equals(t.optString("kind"));
            String code = t.optString("languageCode");
            if (isAsr == asr && (code.equals(lang) || code.startsWith(lang + "-"))) return t;
        }
        return null;
    }

    private static String trackName(JSONObject t) {
        JSONObject name = t.optJSONObject("name");
        if (name != null) {
            if (name.has("simpleText")) return name.optString("simpleText");
            JSONArray runs = name.optJSONArray("runs");
            if (runs != null && runs.length() > 0) return runs.optJSONObject(0).optString("text");
        }
        return t.optString("languageCode");
    }

    /** Gère les deux formats : <text start dur> (secondes) et srv3 <p t d> (millisecondes). */
    static List<Segment> parseXml(String xml) throws IOException {
        List<Segment> out = new ArrayList<>();
        try {
            XmlPullParser p = Xml.newPullParser();
            p.setInput(new StringReader(xml));
            String tag = null;
            double start = 0, dur = 0;
            StringBuilder sb = null;
            int ev;
            while ((ev = p.next()) != XmlPullParser.END_DOCUMENT) {
                if (ev == XmlPullParser.START_TAG) {
                    String n = p.getName();
                    if ("text".equals(n)) {
                        tag = n; sb = new StringBuilder();
                        start = parseD(p.getAttributeValue(null, "start"), 1);
                        dur = parseD(p.getAttributeValue(null, "dur"), 1);
                    } else if ("p".equals(n)) {
                        tag = n; sb = new StringBuilder();
                        start = parseD(p.getAttributeValue(null, "t"), 1000);
                        dur = parseD(p.getAttributeValue(null, "d"), 1000);
                    }
                } else if (ev == XmlPullParser.TEXT && sb != null) {
                    sb.append(p.getText());
                } else if (ev == XmlPullParser.END_TAG && p.getName().equals(tag) && sb != null) {
                    String t = Html.fromHtml(sb.toString(), Html.FROM_HTML_MODE_LEGACY)
                            .toString().replaceAll("\\s+", " ").trim();
                    if (!t.isEmpty()) out.add(new Segment(start, dur, t));
                    sb = null; tag = null;
                }
            }
        } catch (Exception e) {
            throw new IOException("Format de transcription inattendu", e);
        }
        return out;
    }

    private static double parseD(String s, double div) {
        try { return s == null ? 0 : Double.parseDouble(s) / div; }
        catch (NumberFormatException e) { return 0; }
    }

    /** Regroupe les segments en paragraphes d'environ `blockSeconds`. */
    public static List<Segment> group(List<Segment> segs, double blockSeconds) {
        List<Segment> blocks = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        double begin = -1;
        for (Segment s : segs) {
            String t = s.text;
            if (t.matches("^\\[(Musique|Music|Applaudissements|Applause|Rires|Laughter)\\]$")) continue;
            if (begin < 0) begin = s.start;
            if (cur.length() > 0) cur.append(' ');
            cur.append(t);
            double elapsed = s.start + s.duration - begin;
            boolean endSentence = t.endsWith(".") || t.endsWith("!") || t.endsWith("?") || t.endsWith("…");
            if (elapsed >= blockSeconds && (endSentence || elapsed >= blockSeconds * 1.6)) {
                blocks.add(new Segment(begin, elapsed, cur.toString()));
                cur.setLength(0);
                begin = -1;
            }
        }
        if (cur.length() > 0) blocks.add(new Segment(begin, 0, cur.toString()));
        return blocks;
    }

    // ------------------------------------------------------------ HTTP

    private static String post(String url, String json) throws IOException {
        HttpURLConnection c = open(url);
        c.setRequestMethod("POST");
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        try (OutputStream os = c.getOutputStream()) {
            os.write(json.getBytes(StandardCharsets.UTF_8));
        }
        return read(c);
    }

    private static String get(String url) throws IOException {
        return read(open(url));
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("User-Agent", UA);
        c.setRequestProperty("Accept-Language", "fr-FR,fr;q=0.9,en;q=0.8");
        c.setRequestProperty("Cookie", "CONSENT=YES+cb");
        return c;
    }

    private static String read(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (code == 429) throw new IOException("YouTube limite les requêtes (erreur 429). Réessaie plus tard.");
        if (in == null) throw new IOException("Erreur HTTP " + code);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        int n;
        try (InputStream is = in) {
            while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
        }
        String s = bos.toString("UTF-8");
        if (code >= 400) throw new IOException("Erreur HTTP " + code);
        return s;
    }
}
