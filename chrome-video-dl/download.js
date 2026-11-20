// Téléchargement d'un flux HLS : segments en parallèle, déchiffrement AES-128, conversion MP4 (mux.js).
const $ = (id) => document.getElementById(id);
const CONCURRENCY = 6;
const RETRIES = 3;
let cancelled = false;
const aborter = new AbortController();

function step(t, cls) { $('step').textContent = t; $('step').className = cls || ''; }
function detail(t) { $('detail').textContent = t; }
function progress(p) { $('fill').style.width = Math.round(p * 100) + '%'; }

$('cancel').addEventListener('click', () => {
  if (cancelled || $('cancel').dataset.done) return window.close();
  cancelled = true;
  aborter.abort();
  step('Annulé.', 'err');
  $('cancel').textContent = 'Fermer';
});

// Prévient si l'on ferme l'onglet en cours de route
window.addEventListener('beforeunload', (e) => {
  if (!cancelled && !$('cancel').dataset.done) { e.preventDefault(); e.returnValue = ''; }
});

const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r;
});

async function fetchBuf(url, range) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    if (cancelled) throw new Error('annulé');
    try {
      const headers = range ? { Range: range } : {};
      const r = await fetch(url, { credentials: 'include', headers, signal: aborter.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      last = e;
      if (cancelled) throw e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
  throw last;
}

async function fetchText(url) {
  const r = await fetch(url, { credentials: 'include', signal: aborter.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' sur la playlist');
  return { text: await r.text(), url: r.url };
}

/** Playlist média → liste des segments (avec clé AES et plage d'octets éventuelles). */
function parseMedia(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let seq = 0, key = null, map = null, byterange = null, nextOffset = 0;
  const segs = [];
  let duration = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.split(':')[1], 10) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const a = hlsAttrs(l);
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128' && (!a.KEYFORMAT || a.KEYFORMAT === 'identity'))
        key = { uri: new URL(a.URI, base).href, iv: a.IV || null };
      else throw new Error('vidéo protégée (DRM) : téléchargement impossible');
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = hlsAttrs(l);
      map = { url: new URL(a.URI, base).href, range: null };
      if (a.BYTERANGE) {
        const [n, o] = a.BYTERANGE.split('@').map(Number);
        map.range = 'bytes=' + (o || 0) + '-' + ((o || 0) + n - 1);
      }
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, o] = l.split(':')[1].split('@').map(Number);
      const off = isNaN(o) ? nextOffset : o;
      byterange = 'bytes=' + off + '-' + (off + n - 1);
      nextOffset = off + n;
    } else if (l.startsWith('#EXTINF:')) {
      duration += parseFloat(l.slice(8)) || 0;
    } else if (!l.startsWith('#')) {
      segs.push({ url: new URL(l, base).href, key, seq, range: byterange });
      seq++;
      byterange = null;
    }
  }
  return { segs, map, duration, live: !/#EXT-X-ENDLIST/.test(text) };
}

const keyCache = new Map();
async function decrypt(data, seg) {
  if (!seg.key) return data;
  let k = keyCache.get(seg.key.uri);
  if (!k) {
    const raw = await fetchBuf(seg.key.uri);
    k = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    keyCache.set(seg.key.uri, k);
  }
  let iv = new Uint8Array(16);
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
  } else {
    new DataView(iv.buffer).setUint32(12, seg.seq);
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, data));
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, (id) => {
      if (chrome.runtime.lastError || id === undefined) {
        return reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : 'téléchargement refusé'));
      }
      const onChange = (d) => {
        if (d.id !== id || !d.state) return;
        if (d.state.current === 'complete' || d.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChange);
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          d.state.current === 'complete' ? resolve(id) : reject(new Error('enregistrement interrompu'));
        }
      };
      chrome.downloads.onChanged.addListener(onChange);
    });
  });
}

async function run() {
  const id = location.hash.slice(1);
  const job = (await chrome.storage.session.get('job_' + id))['job_' + id];
  if (!job) throw new Error('tâche introuvable (relance depuis l\'icône de l\'extension)');
  $('name').textContent = job.title;
  document.title = '⬇ ' + job.title;

  if (job.mode === 'file') return downloadFile(job, id);

  step('Lecture de la playlist…');
  let { text, url } = await fetchText(job.url);
  if (/#EXT-X-STREAM-INF/.test(text)) {           // maître : on prend la meilleure qualité
    const v = parseMaster(text, url)[0];
    if (!v) throw new Error('aucune qualité dans la playlist');
    if (v.separateAudio) $('warn').textContent = '⚠ Ce site sert le son dans une piste séparée : la vidéo risque d\'être muette.';
    await send({ cmd: 'headers', urls: [v.url], referer: job.referer });
    ({ text, url } = await fetchText(v.url));
  } else if (/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI=/.test(text)) {
    $('warn').textContent = '⚠ Son dans une piste séparée : la vidéo risque d\'être muette.';
  }

  const pl = parseMedia(text, url);
  if (!pl.segs.length) throw new Error('playlist vide');
  if (pl.live) $('warn').textContent = '⚠ Direct : seule la partie déjà disponible sera enregistrée.';

  // Referer/Origin aussi pour les serveurs des segments et des clés
  const hosts = new Set(pl.segs.map((s) => s.url));
  pl.segs.forEach((s) => s.key && hosts.add(s.key.uri));
  if (pl.map) hosts.add(pl.map.url);
  const sample = [...new Set([...hosts].map((u) => new URL(u).origin))].map((o) => o + '/');
  await send({ cmd: 'headers', urls: sample, referer: job.referer });

  const fmp4 = !!pl.map || /\.(m4s|mp4|m4v)$/i.test(new URL(pl.segs[0].url).pathname);
  const total = pl.segs.length;
  step('Téléchargement des segments…');

  // Conversion au fil de l'eau (dans l'ordre) pour libérer la mémoire
  const parts = [];
  let init = null;
  let transmuxer = null;
  const rawTs = [];   // repli si la conversion échoue
  if (fmp4) {
    if (pl.map) parts.push(await fetchBuf(pl.map.url, pl.map.range));
  } else {
    transmuxer = new muxjs.mp4.Transmuxer();
    transmuxer.on('data', (s) => {
      if (!init && s.initSegment && s.initSegment.byteLength) init = new Uint8Array(s.initSegment);
      if (s.data && s.data.byteLength) parts.push(new Uint8Array(s.data));
    });
  }

  const ready = new Array(total);
  let next = 0, done = 0, bytes = 0, idx = 0;
  const t0 = Date.now();

  const consume = () => {
    while (next < total && ready[next]) {
      const d = ready[next];
      ready[next] = null;
      if (fmp4) parts.push(d);
      else {
        rawTs.push(d);
        transmuxer.push(d);
        transmuxer.flush();
      }
      next++;
    }
  };

  const worker = async () => {
    while (idx < total && !cancelled) {
      const i = idx++;
      const s = pl.segs[i];
      const d = await decrypt(await fetchBuf(s.url, s.range), s);
      ready[i] = d;
      bytes += d.byteLength;
      done++;
      progress(done / total * 0.97);
      const speed = bytes / Math.max(1, (Date.now() - t0) / 1000);
      const remain = (total - done) * (bytes / done) / speed;
      detail(done + ' / ' + total + ' segments · ' + fmtSize(bytes) + ' · ' + fmtSize(speed) + '/s'
        + (done < total ? ' · reste ~' + fmtDuration(remain) : ''));
      consume();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (cancelled) return;
  consume();

  step('Assemblage du fichier…');
  let blob, ext;
  if (fmp4) {
    blob = new Blob(parts, { type: 'video/mp4' });
    ext = 'mp4';
  } else if (init && parts.length) {
    blob = new Blob([init, ...parts], { type: 'video/mp4' });
    ext = 'mp4';
  } else {
    blob = new Blob(rawTs, { type: 'video/mp2t' });
    ext = 'ts';
    $('warn').textContent = 'Conversion MP4 impossible pour ce flux : fichier enregistré en .ts (lisible avec VLC).';
  }
  rawTs.length = 0;

  step('Enregistrement dans Téléchargements…');
  await saveBlob(blob, job.title + '.' + ext);
  progress(1);
  step('✓ Enregistré dans Téléchargements : ' + job.title + '.' + ext + ' (' + fmtSize(blob.size) + ')', 'ok');
  $('cancel').textContent = 'Fermer';
  $('cancel').dataset.done = '1';
  chrome.storage.session.remove('job_' + id);
}

/** Fichier vidéo direct, quand le serveur exige le Referer de la page. */
async function downloadFile(job, id) {
  step('Téléchargement…');
  const r = await fetch(job.url, { credentials: 'include', signal: aborter.signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const total = +(r.headers.get('content-length') || 0);
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    const speed = got / Math.max(1, (Date.now() - t0) / 1000);
    if (total) progress(got / total * 0.97);
    detail(fmtSize(got) + (total ? ' / ' + fmtSize(total) : '') + ' · ' + fmtSize(speed) + '/s'
      + (total ? ' · reste ~' + fmtDuration((total - got) / speed) : ''));
  }
  step('Enregistrement dans Téléchargements…');
  const blob = new Blob(chunks, { type: r.headers.get('content-type') || 'video/mp4' });
  chunks.length = 0;
  await saveBlob(blob, job.title + '.' + job.ext);
  progress(1);
  step('✓ Enregistré dans Téléchargements : ' + job.title + '.' + job.ext + ' (' + fmtSize(blob.size) + ')', 'ok');
  $('cancel').textContent = 'Fermer';
  $('cancel').dataset.done = '1';
  chrome.storage.session.remove('job_' + id);
}

run().catch((e) => {
  if (cancelled) return;
  step('Échec : ' + (e.message || e), 'err');
  $('cancel').textContent = 'Fermer';
  $('cancel').dataset.done = '1';
});
