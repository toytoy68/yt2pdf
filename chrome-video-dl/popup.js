const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
  if (r && r.error) throw new Error(r.error);
  return r;
});

let tab;

function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
function fileName(u) {
  try { const p = new URL(u).pathname; const n = p.slice(p.lastIndexOf('/') + 1); return n.length > 38 ? '…' + n.slice(-38) : n; }
  catch { return ''; }
}

function showEmpty(extra) {
  const yt = /(^|\.)youtube\.com$/.test(hostOf(tab.url));
  $('list').innerHTML = '';
  const d = document.createElement('div');
  d.className = 'empty';
  d.textContent = yt
    ? "YouTube n'est pas pris en charge : ses vidéos sont découpées et chiffrées."
    : 'Aucune vidéo détectée. Lance la lecture de la vidéo (quelques secondes), puis rouvre cette fenêtre.';
  $('list').appendChild(d);
  if (extra) {
    const e = document.createElement('div');
    e.className = 'hint';
    e.textContent = extra;
    $('list').appendChild(e);
  }
}

async function render() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('title').textContent = tab.title || tab.url;
  const { items } = await send({ cmd: 'list', tabId: tab.id });
  if (!items.length) return showEmpty();

  // Les playlists HLS sont analysées pour connaître les qualités
  const probed = await Promise.all(items.map(async (it) => {
    if (it.kind !== 'hls') return { it };
    try { return { it, p: await send({ cmd: 'probe', item: it, pageUrl: tab.url }) }; }
    catch (e) { return { it, err: e.message }; }
  }));

  const hasMaster = probed.some((x) => x.p && x.p.master);
  let entries = probed.filter((x) => {
    if (x.it.kind === 'dash') return false;                     // pistes séparées : non géré
    if (x.it.kind === 'hls' && x.p && !x.p.master && hasMaster) return false; // déjà couvert par la maître
    if (x.err) return false;
    return true;
  });
  const score = (x) => {
    if (x.p && x.p.master) return 3e12 + (x.p.variants[0] ? x.p.variants[0].height : 0);
    if (x.it.kind === 'hls') return 2e12 + (x.p ? x.p.duration : 0);
    return x.it.size || 1;
  };
  entries.sort((a, b) => score(b) - score(a));
  if (!entries.length) {
    const dash = probed.some((x) => x.it.kind === 'dash');
    return showEmpty(dash ? 'Ce site utilise le format DASH (pistes audio et vidéo séparées), non géré pour le moment.' : '');
  }

  $('list').innerHTML = '';
  entries.forEach((x, i) => $('list').appendChild(card(x, i === 0)));
}

function card({ it, p }, best) {
  const c = document.createElement('div');
  c.className = 'card' + (best ? ' best' : '');
  const k = document.createElement('div');
  k.className = 'kind';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const row = document.createElement('div');
  row.className = 'row';
  const btn = document.createElement('button');
  btn.className = 'dl';
  btn.textContent = 'Télécharger';
  let select = null;

  if (it.kind === 'file') {
    k.textContent = (best ? '★ ' : '') + 'Fichier ' + it.ext.toUpperCase() + (it.size ? ' · ' + fmtSize(it.size) : '');
    meta.textContent = hostOf(it.url) + ' / ' + fileName(it.url);
  } else if (p.master) {
    k.textContent = (best ? '★ ' : '') + 'Flux HLS · ' + p.variants.length + ' qualité' + (p.variants.length > 1 ? 's' : '');
    meta.textContent = hostOf(it.url);
    select = document.createElement('select');
    for (const v of p.variants) {
      const o = document.createElement('option');
      o.value = v.url;
      o.textContent = (v.height ? v.height + 'p' : 'qualité ?') + (v.bandwidth ? ' · ' + (v.bandwidth / 1e6).toFixed(1).replace('.', ',') + ' Mb/s' : '')
        + (v.separateAudio ? ' (son séparé)' : '');
      select.appendChild(o);
    }
    row.appendChild(select);
  } else {
    k.textContent = (best ? '★ ' : '') + 'Flux HLS' + (p.duration ? ' · ' + fmtDuration(p.duration) : '');
    meta.textContent = hostOf(it.url) + ' / ' + fileName(it.url);
    if (p.drm) { btn.disabled = true; btn.textContent = 'Protégé (DRM)'; }
  }
  row.appendChild(btn);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Lancement…';
    try {
      const r = await send({
        cmd: 'download', item: it, variant: select ? select.value : null,
        tabId: tab.id, title: tab.title, pageUrl: tab.url,
      });
      btn.textContent = r.mode === 'direct' ? '✓ Lancé (voir Téléchargements)' : '✓ Lancé (onglet ouvert)';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Réessayer';
      $('status').className = 'err';
      $('status').textContent = 'Échec : ' + e.message;
    }
  });

  c.append(k, meta, row);
  return c;
}

$('clear').addEventListener('click', async () => {
  await send({ cmd: 'clear', tabId: tab.id, pageUrl: tab.url });
  showEmpty();
});

render().catch((e) => {
  $('status').className = 'err';
  $('status').textContent = 'Erreur : ' + e.message;
});
