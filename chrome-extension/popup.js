/* global ytGetTranscript, jspdf */
const $ = (id) => document.getElementById(id);
let tab = null;
let lastText = "";

// ---------------------------------------------------------------- démarrage

(async function init() {
  const saved = await chrome.storage.local.get({ lang: "fr", ts: true, bloc: "45" });
  $("lang").value = saved.lang;
  $("ts").checked = saved.ts;
  $("bloc").value = saved.bloc;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ok = tab && /^https:\/\/(www|m)\.youtube\.com\/(watch|shorts|live)/.test(tab.url || "");
  if (!ok) {
    $("video").textContent = "Ouvre une vidéo YouTube puis reclique sur l'icône.";
    $("go").disabled = true;
    return;
  }
  $("video").textContent = (tab.title || "").replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, "");
})();

$("go").addEventListener("click", run);
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText(lastText);
  status("Texte copié dans le presse-papiers.", "ok");
});

function status(msg, cls = "") {
  $("status").className = cls;
  $("status").textContent = msg;
}

// ---------------------------------------------------------------- traitement

async function run() {
  const lang = $("lang").value.trim().toLowerCase() || "fr";
  const ts = $("ts").checked;
  const bloc = +$("bloc").value;
  chrome.storage.local.set({ lang, ts, bloc: String(bloc) });

  $("go").disabled = true;
  $("copy").classList.add("hidden");
  status("Récupération de la transcription…");

  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: ytGetTranscript,
      args: [lang],
    });
    const r = inj && inj.result;
    if (!r) throw new Error("Pas de réponse de la page (recharge-la et réessaie).");
    if (r.error) throw new Error(r.error);

    status("Création du PDF…");
    const blocks = group(r.items, bloc);
    lastText = blocks.map((b) => b.type === "chap" ? "\n## " + b.text + "\n" : (ts ? `[${hms(b.start)}] ` : "") + b.text).join("\n\n");

    const blob = await makePdf(r, blocks, ts);
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: safeName(r.title) + ".pdf", saveAs: false });
    status(`✓ PDF téléchargé (${blocks.filter((b) => b.type === "seg").length} paragraphes).`, "ok");
    $("copy").classList.remove("hidden");
  } catch (e) {
    status(e.message, "err");
  } finally {
    $("go").disabled = false;
  }
}

// Regroupe les petits segments en paragraphes ; les chapitres coupent les paragraphes.
function group(items, blocSec) {
  const out = [];
  let cur = [], begin = null, last = 0;
  const flush = () => {
    if (cur.length) out.push({ type: "seg", start: begin, text: cur.join(" ") });
    cur = []; begin = null;
  };
  const noise = /^\[(musique|music|applaudissements|applause|rires|laughter)\]$/i;
  for (const it of items) {
    if (it.type === "chap") { flush(); out.push(it); continue; }
    if (noise.test(it.text)) continue;
    if (begin === null) begin = it.start;
    cur.push(it.text);
    last = it.start;
    const elapsed = last - begin;
    const endSentence = /[.!?…]$/.test(it.text);
    if (elapsed >= blocSec && (endSentence || elapsed >= blocSec * 1.6)) flush();
  }
  flush();
  return out;
}

function hms(s) {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}

function safeName(t) {
  return (t || "transcription").replace(/[\\/:*?"<>|~]+/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "transcription";
}

// ---------------------------------------------------------------- PDF

async function fontB64(path) {
  const buf = await (await fetch(chrome.runtime.getURL(path))).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function makePdf(r, blocks, ts) {
  const { jsPDF } = jspdf;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.addFileToVFS("DejaVuSans.ttf", await fontB64("fonts/DejaVuSans.ttf"));
  doc.addFont("DejaVuSans.ttf", "DejaVu", "normal");
  doc.addFileToVFS("DejaVuSans-Bold.ttf", await fontB64("fonts/DejaVuSans-Bold.ttf"));
  doc.addFont("DejaVuSans-Bold.ttf", "DejaVu", "bold");

  const W = 595.28, H = 841.89, ML = 56, MR = 56, MT = 56, MB = 60, TW = W - ML - MR;
  const url = "https://www.youtube.com/watch?v=" + r.videoId;
  let y = MT;

  const ensure = (h) => { if (y + h > H - MB) { doc.addPage(); y = MT; } };
  const write = (text, size, color, style, lh, opts = {}) => {
    doc.setFont("DejaVu", style); doc.setFontSize(size); doc.setTextColor(...color);
    for (const line of doc.splitTextToSize(text, TW)) {
      ensure(lh);
      y += lh;
      if (opts.link) doc.textWithLink(line, ML, y - lh * 0.25, { url: opts.link });
      else doc.text(line, ML, y - lh * 0.25);
    }
  };

  doc.setProperties({ title: r.title, author: r.author, subject: "Transcription YouTube", creator: "YT → PDF" });

  write(r.title, 17, [0, 0, 0], "bold", 22);
  y += 6;
  if (r.author) write("Chaîne : " + r.author, 9, [85, 85, 85], "normal", 13);
  write(url, 9, [0, 0, 200], "normal", 13, { link: url });
  if (r.language) write("Sous-titres : " + r.language, 9, [85, 85, 85], "normal", 13);
  const d = new Date();
  write(`Extrait le ${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`,
        9, [85, 85, 85], "normal", 13);
  y += 6;
  doc.setDrawColor(200); doc.line(ML, y, W - MR, y);
  y += 18;

  for (const b of blocks) {
    if (b.type === "chap") {
      ensure(22 + 16 * 3);
      y += 6;
      write(b.text, 13, [0, 0, 0], "bold", 20);
      y += 4;
      continue;
    }
    if (ts) {
      ensure(13 + 16 * 2);   // pas d'horodatage orphelin en bas de page
      write(`[${hms(b.start)}]`, 9, [196, 48, 43], "bold", 13, { link: `${url}&t=${Math.floor(b.start)}s` });
    }
    write(b.text, 11, [0, 0, 0], "normal", 16);
    y += 9;
  }

  // Pied de page
  const n = doc.getNumberOfPages();
  const foot = r.title.length > 75 ? r.title.slice(0, 75) + "…" : r.title;
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setFont("DejaVu", "normal"); doc.setFontSize(8); doc.setTextColor(128);
    doc.text(foot, ML, H - 32);
    doc.text(`Page ${i} / ${n}`, W - MR, H - 32, { align: "right" });
  }
  return doc.output("blob");
}
