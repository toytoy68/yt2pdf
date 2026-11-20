/*
 * Fonction injectée DANS la page YouTube (monde "MAIN") : elle a accès à ytcfg
 * et aux cookies de YouTube. Elle doit être autonome (aucune référence extérieure).
 * Renvoie { videoId, title, author, language, auto, items:[{type:'seg'|'chap', start, text}] }
 * ou { error }.
 */
async function ytGetTranscript(prefLang) {
  const log = [];
  try {
    const u = new URL(location.href);
    const videoId = u.searchParams.get("v") ||
      (u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/) || [])[1];
    if (!videoId) return { error: "Ouvre d'abord une vidéo YouTube." };

    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    const apiKey = cfg && cfg.get("INNERTUBE_API_KEY");
    const context = cfg && cfg.get("INNERTUBE_CONTEXT");
    const hl = (context && context.client && context.client.hl) || "fr";

    // ---------- utilitaires
    const findKey = (obj, key, max = 1) => {
      const out = [];
      const stack = [obj];
      while (stack.length && out.length < max) {
        const o = stack.pop();
        if (!o || typeof o !== "object") continue;
        if (Object.prototype.hasOwnProperty.call(o, key)) out.push(o[key]);
        for (const k in o) if (o[k] && typeof o[k] === "object") stack.push(o[k]);
      }
      return max === 1 ? out[0] : out;
    };
    const runsText = (t) => !t ? "" : (t.simpleText != null ? t.simpleText
      : (t.runs || []).map((r) => r.text).join(""));
    const extract = (html, name) => {
      const i = html.indexOf(name + " = {") >= 0 ? html.indexOf(name + " = {") : html.indexOf(name + "={");
      if (i < 0) return null;
      let start = html.indexOf("{", i), depth = 0, inStr = false, esc = false;
      for (let j = start; j < html.length; j++) {
        const c = html[j];
        if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; }
        }
      }
      return null;
    };

    // ---------- page fraîche (ytInitialData de la page peut être périmé après navigation interne)
    const html = await (await fetch("/watch?v=" + videoId + "&hl=" + hl, { credentials: "include" })).text();
    const initialData = extract(html, "ytInitialData");
    const player = extract(html, "ytInitialPlayerResponse");
    const vd = (player && player.videoDetails) || {};
    const res = {
      videoId,
      title: vd.title || document.title.replace(/ - YouTube$/, ""),
      author: vd.author || "",
      language: "", auto: false, items: [],
    };

    const wantName = (() => {
      try { return new Intl.DisplayNames([hl], { type: "language" }).of(prefLang).toLowerCase(); }
      catch (e) { return prefLang.toLowerCase(); }
    })();
    const isAutoTitle = (t) => /auto|automati/i.test(t);

    // ---------- Méthode 1 : API get_transcript (celle du panneau « Transcription »)
    const getTranscript = async (params) => {
      const r = await fetch("/youtubei/v1/get_transcript?prettyPrint=false" + (apiKey ? "&key=" + apiKey : ""), {
        method: "POST", credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": "1",
          "X-Youtube-Client-Version": context.client.clientVersion,
        },
        body: JSON.stringify({ context, params }),
      });
      if (!r.ok) throw new Error("get_transcript HTTP " + r.status);
      return r.json();
    };
    const parseGT = (json) => {
      const list = findKey(json, "transcriptSegmentListRenderer");
      const segs = (list && list.initialSegments) || [];
      const items = [];
      for (const s of segs) {
        if (s.transcriptSegmentRenderer) {
          const t = s.transcriptSegmentRenderer;
          const text = runsText(t.snippet).replace(/\s+/g, " ").trim();
          if (text) items.push({ type: "seg", start: (+t.startMs || 0) / 1000, text });
        } else if (s.transcriptSectionHeaderRenderer) {
          const h = s.transcriptSectionHeaderRenderer;
          const text = (runsText(h.snippet) ||
            (h.sectionHeader?.sectionHeaderViewModel?.headline?.content) || "").trim();
          if (text) items.push({ type: "chap", start: (+h.startMs || 0) / 1000, text });
        }
      }
      const menu = findKey(json, "languageMenu");
      const langs = ((menu && menu.sortFilterSubMenuRenderer && menu.sortFilterSubMenuRenderer.subMenuItems) || [])
        .map((m) => ({
          title: m.title || "",
          selected: !!m.selected,
          params: m.continuation && m.continuation.reloadContinuationData &&
                  m.continuation.reloadContinuationData.continuation,
        }));
      return { items, langs };
    };

    try {
      if (!context) throw new Error("ytcfg indisponible");
      const params = findKey(initialData, "getTranscriptEndpoint");
      if (!params || !params.params) throw new Error("pas de transcription proposée");
      let gt = parseGT(await getTranscript(params.params));
      let current = gt.langs.find((l) => l.selected);
      // Choisir la langue : manuelle puis auto dans la langue voulue
      const matches = gt.langs.filter((l) => l.title.toLowerCase().startsWith(wantName));
      const best = matches.find((l) => !isAutoTitle(l.title)) || matches[0];
      if (best && current && best.title !== current.title && best.params) {
        gt = { ...parseGT(await getTranscript(best.params)), langs: gt.langs };
        current = best;
      }
      if (gt.items.length) {
        res.items = gt.items;
        res.language = current ? current.title : "";
        res.auto = current ? isAutoTitle(current.title) : false;
        res.method = "get_transcript";
        return res;
      }
      throw new Error("réponse vide");
    } catch (e) { log.push("API : " + e.message); }

    // ---------- Méthode 2 : pistes de sous-titres (timedtext)
    try {
      const tracks = player && player.captions &&
        player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks;
      if (!tracks || !tracks.length) throw new Error("aucune piste");
      const pick = (code, asr) => tracks.find((t) =>
        (t.languageCode === code || t.languageCode.startsWith(code + "-")) && ((t.kind === "asr") === asr));
      let tr = pick(prefLang, false) || pick(prefLang, true) || pick("en", false) || pick("en", true);
      let tlang = "";
      if (!tr) { tr = tracks[0]; if (tr.isTranslatable) tlang = "&tlang=" + prefLang; }
      const r = await fetch(tr.baseUrl.replace(/&fmt=[^&]*/, "") + "&fmt=json3" + tlang, { credentials: "include" });
      const txt = await r.text();
      if (!txt.trim()) throw new Error("réponse vide (jeton requis)");
      const j = JSON.parse(txt);
      for (const ev of j.events || []) {
        if (!ev.segs) continue;
        const text = ev.segs.map((s) => s.utf8 || "").join("").replace(/\s+/g, " ").trim();
        if (text) res.items.push({ type: "seg", start: (ev.tStartMs || 0) / 1000, text });
      }
      if (!res.items.length) throw new Error("vide");
      res.language = runsText(tr.name) + (tlang ? " → " + prefLang : "");
      res.auto = tr.kind === "asr";
      res.method = "timedtext";
      return res;
    } catch (e) { log.push("Pistes : " + e.message); }

    // ---------- Méthode 3 : ouvrir le panneau « Transcription » et le lire
    try {
      if (new URL(location.href).searchParams.get("v") !== videoId) throw new Error("page différente");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const segSel = "ytd-transcript-segment-renderer";
      if (!document.querySelector(segSel)) {
        const btn = document.querySelector("ytd-video-description-transcript-section-renderer button") ||
          [...document.querySelectorAll("button")].find((b) => /transcri/i.test(b.getAttribute("aria-label") || b.textContent));
        if (!btn) throw new Error("bouton Transcription introuvable");
        btn.click();
        for (let i = 0; i < 40 && !document.querySelector(segSel); i++) await sleep(250);
      }
      const nodes = document.querySelectorAll(segSel + ", ytd-transcript-section-header-renderer");
      for (const n of nodes) {
        const text = (n.querySelector(".segment-text, yt-formatted-string") || n).textContent.replace(/\s+/g, " ").trim();
        const ts = (n.querySelector(".segment-timestamp") || {}).textContent || "";
        const p = ts.trim().split(":").map(Number);
        const start = p.reduce((a, b) => a * 60 + (b || 0), 0);
        if (!text) continue;
        res.items.push({ type: n.tagName.toLowerCase().includes("header") ? "chap" : "seg", start, text });
      }
      if (!res.items.length) throw new Error("panneau vide");
      const lbl = document.querySelector("ytd-transcript-footer-renderer #label-text, ytd-transcript-footer-renderer yt-dropdown-menu");
      res.language = lbl ? lbl.textContent.trim() : "";
      res.auto = isAutoTitle(res.language);
      res.method = "panneau";
      return res;
    } catch (e) { log.push("Panneau : " + e.message); }

    return { error: "Impossible de récupérer la transcription.\n" + log.join("\n") };
  } catch (e) {
    return { error: "Erreur : " + e.message + (log.length ? "\n" + log.join("\n") : "") };
  }
}
