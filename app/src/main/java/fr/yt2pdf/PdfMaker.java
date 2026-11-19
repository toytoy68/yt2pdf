package fr.yt2pdf;

import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Typeface;
import android.graphics.pdf.PdfDocument;

import java.io.IOException;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Génère un PDF A4 à partir d'une transcription, avec l'API native d'Android. */
public class PdfMaker {

    private static final int W = 595, H = 842;          // A4 en points
    private static final float ML = 56, MR = 56, MT = 56, MB = 60;

    private final PdfDocument doc = new PdfDocument();
    private PdfDocument.Page page;
    private Canvas canvas;
    private int pageNo = 0;
    private float y;
    private final String footerTitle;

    private final Paint pTitle = paint(17, Color.BLACK, true);
    private final Paint pMeta = paint(9, Color.rgb(85, 85, 85), false);
    private final Paint pBody = paint(11, Color.BLACK, false);
    private final Paint pTime = paint(9, Color.rgb(196, 48, 43), true);
    private final Paint pFoot = paint(8, Color.GRAY, false);
    private final Paint pLine = paint(1, Color.rgb(200, 200, 200), false);

    private PdfMaker(String footerTitle) { this.footerTitle = footerTitle; }

    private static Paint paint(float size, int color, boolean bold) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setTextSize(size);
        p.setColor(color);
        p.setTypeface(Typeface.create(Typeface.SANS_SERIF, bold ? Typeface.BOLD : Typeface.NORMAL));
        return p;
    }

    public static void write(YouTubeTranscript.Result r, List<YouTubeTranscript.Segment> blocks,
                             boolean timestamps, OutputStream out) throws IOException {
        PdfMaker m = new PdfMaker(r.title);
        m.newPage();

        m.text(r.title, m.pTitle, 22);
        m.y += 6;
        if (r.author != null && !r.author.isEmpty()) m.text("Chaîne : " + r.author, m.pMeta, 13);
        m.text("https://www.youtube.com/watch?v=" + r.videoId, m.pMeta, 13);
        m.text("Sous-titres : " + r.language + (r.auto ? " (générés automatiquement)" : ""), m.pMeta, 13);
        String date = new SimpleDateFormat("dd/MM/yyyy 'à' HH:mm", Locale.FRANCE).format(new Date());
        m.text("Extrait le " + date, m.pMeta, 13);
        m.y += 6;
        m.canvas.drawLine(ML, m.y, W - MR, m.y, m.pLine);
        m.y += 18;

        for (YouTubeTranscript.Segment b : blocks) {
            if (timestamps) {
                m.ensure(13 + 16 * 2);   // évite un horodatage orphelin en bas de page
                m.text("[" + hms(b.start) + "]", m.pTime, 13);
            }
            m.text(b.text, m.pBody, 16);
            m.y += 9;
        }

        m.finishPage();
        m.doc.writeTo(out);
        m.doc.close();
    }

    static String hms(double sec) {
        int s = (int) sec, h = s / 3600, mi = (s % 3600) / 60, se = s % 60;
        return h > 0 ? String.format(Locale.ROOT, "%d:%02d:%02d", h, mi, se)
                     : String.format(Locale.ROOT, "%02d:%02d", mi, se);
    }

    // ------------------------------------------------------------ mise en page

    private void newPage() {
        pageNo++;
        page = doc.startPage(new PdfDocument.PageInfo.Builder(W, H, pageNo).create());
        canvas = page.getCanvas();
        y = MT;
    }

    private void finishPage() {
        String t = footerTitle.length() > 70 ? footerTitle.substring(0, 70) + "…" : footerTitle;
        canvas.drawText(t, ML, H - 32, pFoot);
        String n = "Page " + pageNo;
        canvas.drawText(n, W - MR - pFoot.measureText(n), H - 32, pFoot);
        doc.finishPage(page);
    }

    private void ensure(float needed) {
        if (y + needed > H - MB) { finishPage(); newPage(); }
    }

    /** Écrit un texte avec retour à la ligne automatique et sauts de page. */
    private void text(String s, Paint p, float lineHeight) {
        for (String line : wrap(s, p, W - ML - MR)) {
            ensure(lineHeight);
            y += lineHeight;
            canvas.drawText(line, ML, y - lineHeight * 0.25f, p);
        }
    }

    private static List<String> wrap(String s, Paint p, float maxW) {
        List<String> lines = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (String word : s.split(" ")) {
            if (word.isEmpty()) continue;
            String test = cur.length() == 0 ? word : cur + " " + word;
            if (p.measureText(test) <= maxW) {
                cur.setLength(0);
                cur.append(test);
                continue;
            }
            if (cur.length() > 0) { lines.add(cur.toString()); cur.setLength(0); }
            // mot plus long qu'une ligne : on le coupe
            while (p.measureText(word) > maxW) {
                int n = p.breakText(word, true, maxW, null);
                if (n <= 0) n = 1;
                lines.add(word.substring(0, n));
                word = word.substring(n);
            }
            cur.append(word);
        }
        if (cur.length() > 0) lines.add(cur.toString());
        return lines;
    }
}
