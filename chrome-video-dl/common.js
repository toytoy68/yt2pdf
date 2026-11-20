// Fonctions partagées (service worker, popup, page de téléchargement)

/** Nom de fichier valide sous Windows. */
function safeName(s, fallback = 'video') {
  s = (s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || fallback;
}

function fmtSize(b) {
  if (!b) return '';
  if (b >= 1e9) return (b / 1e9).toFixed(2).replace('.', ',') + ' Go';
  if (b >= 1e6) return Math.round(b / 1e6) + ' Mo';
  return Math.round(b / 1e3) + ' ko';
}

function fmtDuration(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ' h ' : '') + (h || m ? m + ' min ' : '') + (h ? '' : r + ' s');
}

/** Lit les attributs d'une balise HLS : A=1,B="x,y" → {A:'1', B:'x,y'} */
function hlsAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

/** Analyse une playlist maître : liste des qualités, meilleure d'abord. */
function parseMaster(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const audioGroups = {};
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = hlsAttrs(l);
      if (a.TYPE === 'AUDIO' && a.URI) audioGroups[a['GROUP-ID']] = new URL(a.URI, base).href;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = hlsAttrs(l);
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trim().startsWith('#'))) j++;
      if (j < lines.length) {
        const res = a.RESOLUTION ? a.RESOLUTION.split('x').map(Number) : null;
        variants.push({
          url: new URL(lines[j].trim(), base).href,
          bandwidth: +(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH || 0),
          height: res ? res[1] : 0,
          separateAudio: a.AUDIO && audioGroups[a.AUDIO] ? audioGroups[a.AUDIO] : null,
        });
      }
      i = j;
    }
  }
  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return variants;
}

/** Durée totale d'une playlist média (secondes). */
function hlsDuration(text) {
  let d = 0;
  for (const m of text.matchAll(/#EXTINF:\s*([\d.]+)/g)) d += parseFloat(m[1]);
  return d;
}
