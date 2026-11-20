/*
 * Fonction injectée DANS la page YouTube (monde "MAIN") : elle a accès au lecteur,
 * à ytcfg et aux cookies de YouTube. Elle doit être autonome (aucune référence extérieure).
 * Renvoie { videoId, title, author, language, auto, method, items:[{type:'seg'|'chap', start, text}] }
 * ou { error }.
 */
async function ytGetTranscript(prefLang) {
  const log = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const u = new URL(location.href);
    const videoId = u.searchParams.get("v") ||
      (u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/) || [])[1];
    if (!videoId) return { error: "Ouvre d'abord une vidéo YouTube." };

    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    const context = cfg && cfg.get("INNERTUBE_CONTEXT");
    const hl = (context && context.client && context.client.hl) || "fr";
    const player = document.getElementById("movie_player") ||
      document.querySelector("#shorts-player, .html5-video-player");

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
      let i = html.indexOf(name + " = {");
      if (i < 0) i = html.indexOf(name + "={");
      if (i < 0) return null;
      const start = html.indexOf("{", i);
      let depth = 0, inStr = false, esc = false;
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
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

    // ---------- infos de la vidéo + chapitres (page fraîche : ytInitialData peut être périmé)
    let initialData = null, playerResp = null;
    try {
      const html = await (await fetch("/watch?v=" + videoId + "&hl=" + hl, { credentials: "include" })).text();
      initialData = extract(html, "ytInitialData");
      playerResp = extract(html, "ytInitialPlayerResponse");
    } catch (e) { log.push("Page : " + e.message); }

    const vd = (playerResp && playerResp.videoDetails) || {};
    const pd = (player && player.getVideoData && player.getVideoData()) || {};
    const res = {
      videoId,
      title: vd.title || (pd.video_id === videoId && pd.title) || document.title.replace(/ - YouTube$/, ""),
      author: vd.author || (pd.video_id === videoId && pd.author) || "",
      language: "", auto: false, items: [],
    };

    const chapters = [];
    for (const list of findKey(initialData, "chapters", 5) || []) {
      if (!Array.isArray(list)) continue;
      for (const c of list) {
        const r = c && c.chapterRenderer;
        if (r) chapters.push({ type: "chap", start: (r.timeRangeStartMillis || 0) / 1000, text: clean(runsText(r.title)) });
      }
      if (chapters.length) break;
    }
    const withChapters = (items) => {
      if (!chapters.length || items.some((i) => i.type === "chap")) return items;
      return [...items, ...chapters.filter((c) => c.text)].sort((a, b) =>
        a.start - b.start || (a.type === "chap" ? -1 : 1));
    };

    const isAuto = (t) => /auto|automati/i.test(t || "");

    // ---------- Méthode 1 : jeton du lecteur (affiche brièvement les sous-titres)
    try {
      if (!player || !player.toggleSubtitlesOn) throw new Error("lecteur introuvable");
      if (player.getVideoData().video_id !== videoId) throw new Error("une pub est en cours, attends sa fin");

      const ok = (n) => n.includes("/api/timedtext") && n.includes("v=" + videoId) && n.includes("pot=");
      const pick = () => performance.getEntriesByType("resource").map((e) => e.name).filter(ok).pop();
      try { performance.setResourceTimingBufferSize(5000); } catch (e) { /* ignore */ }

      let url = pick();
      const wasOn = player.isSubtitlesOn ? player.isSubtitlesOn() : false;
      if (!url) {
        const waitUrl = new Promise((resolve) => {
          const obs = new PerformanceObserver((list) => {
            const x = list.getEntries().map((e) => e.name).filter(ok).pop() || pick();
            if (x) { obs.disconnect(); resolve(x); }
          });
          obs.observe({ type: "resource" });
          setTimeout(() => { obs.disconnect(); resolve(pick() || null); }, 8000);
        });
        if (wasOn) { player.toggleSubtitles(); await sleep(300); }
        player.toggleSubtitlesOn();
        url = await waitUrl;
        if (!wasOn) player.toggleSubtitles();
      }
      if (!url) throw new Error("le lecteur n'a pas chargé de sous-titres");

      // Choix de la piste
      let tracks = [];
      try { tracks = player.getOption("captions", "tracklist", { includeAsr: true }) || []; } catch (e) { /* ignore */ }
      if (!tracks.length) {
        const pt = playerResp && playerResp.captions && playerResp.captions.playerCaptionsTracklistRenderer;
        tracks = ((pt && pt.captionTracks) || []).map((t) => ({
          languageCode: t.languageCode, kind: t.kind || "", displayName: runsText(t.name),
        }));
      }
      const match = (t, code) => t.languageCode === code || (t.languageCode || "").startsWith(code + "-");
      const find = (code, asr) => tracks.find((t) => match(t, code) && ((t.kind === "asr") === asr));
      let tr = find(prefLang, false) || find(prefLang, true) || find("en", false) || find("en", true);
      let tlang = "";
      if (!tr) {
        const cur = new URL(url).searchParams;
        tr = tracks[0] || { languageCode: cur.get("lang"), kind: cur.get("kind") || "" };
        if (tr.languageCode !== prefLang) tlang = prefLang;
      }

      const q = new URL(url);
      q.searchParams.set("fmt", "json3");
      q.searchParams.set("lang", tr.languageCode);
      if (tr.kind === "asr") q.searchParams.set("kind", "asr"); else q.searchParams.delete("kind");
      q.searchParams.delete("variant");
      if (tlang) q.searchParams.set("tlang", tlang); else q.searchParams.delete("tlang");

      const r = await fetch(q.toString(), { credentials: "include" });
      const txt = await r.text();
      if (!r.ok || !txt.trim()) throw new Error("réponse vide (HTTP " + r.status + ")");
      const j = JSON.parse(txt);
      const items = [];
      for (const ev of j.events || []) {
        if (!ev.segs) continue;
        const text = clean(ev.segs.map((s) => s.utf8 || "").join(""));
        if (text) items.push({ type: "seg", start: (ev.tStartMs || 0) / 1000, text });
      }
      if (!items.length) throw new Error("transcription vide");
      res.items = withChapters(items);
      res.language = (tr.displayName || tr.languageName || tr.languageCode) +
        (tlang ? " → traduit (" + tlang + ")" : "");
      res.auto = tr.kind === "asr";
      res.method = "lecteur";
      return res;
    } catch (e) { log.push("Lecteur : " + e.message); }

    // ---------- Méthode 2 : API get_transcript (celle du panneau « Transcription »)
    try {
      if (!context) throw new Error("ytcfg indisponible");
      const ep = findKey(initialData, "getTranscriptEndpoint");
      if (!ep || !ep.params) throw new Error("pas de transcription proposée");
      const r = await fetch("/youtubei/v1/get_transcript?prettyPrint=false", {
        method: "POST", credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "X-Youtube-Client-Name": "1",
          "X-Youtube-Client-Version": context.client.clientVersion,
        },
        body: JSON.stringify({ context, params: ep.params }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const json = await r.json();
      const list = findKey(json, "transcriptSegmentListRenderer");
      for (const s of (list && list.initialSegments) || []) {
        const t = s.transcriptSegmentRenderer;
        const h = s.transcriptSectionHeaderRenderer;
        if (t) {
          const text = clean(runsText(t.snippet));
          if (text) res.items.push({ type: "seg", start: (+t.startMs || 0) / 1000, text });
        } else if (h) {
          const text = clean(runsText(h.snippet) || h.sectionHeader?.sectionHeaderViewModel?.headline?.content);
          if (text) res.items.push({ type: "chap", start: (+h.startMs || 0) / 1000, text });
        }
      }
      if (!res.items.length) throw new Error("réponse vide");
      res.items = withChapters(res.items);
      res.method = "get_transcript";
      return res;
    } catch (e) { log.push("API : " + e.message); }

    // ---------- Méthode 3 : ouvrir le panneau « Transcription » et le lire
    try {
      const segSel = "transcript-segment-view-model, ytd-transcript-segment-renderer";
      const panel = () => document.querySelector('[target-id="engagement-panel-searchable-transcript"]');
      if (!document.querySelector(segSel)) {
        const p = panel();
        if (p) p.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        const btns = [...document.querySelectorAll("ytd-video-description-transcript-section-renderer button")];
        for (const b of btns) b.click();
        for (let i = 0; i < 60 && !document.querySelector(segSel); i++) await sleep(250);
      }
      const nodes = document.querySelectorAll(segSel +
        ", ytd-transcript-section-header-renderer, transcript-section-header-view-model");
      for (const n of nodes) {
        const tag = n.tagName.toLowerCase();
        const tsEl = n.querySelector(".ytwTranscriptSegmentViewModelTimestamp, .segment-timestamp");
        const txtEl = n.querySelector(".ytAttributedStringHost, .segment-text, yt-formatted-string") || n;
        const text = clean(txtEl.textContent);
        const parts = clean(tsEl && tsEl.textContent).split(":").map(Number);
        const start = parts.reduce((a, b) => a * 60 + (b || 0), 0);
        if (text) res.items.push({ type: tag.includes("header") ? "chap" : "seg", start, text });
      }
      if (!res.items.length) throw new Error("panneau vide");
      res.items = withChapters(res.items);
      res.method = "panneau";
      return res;
    } catch (e) { log.push("Panneau : " + e.message); }

    return { error: "Impossible de récupérer la transcription.\n" + log.join("\n") };
  } catch (e) {
    return { error: "Erreur : " + e.message + (log.length ? "\n" + log.join("\n") : "") };
  }
}
