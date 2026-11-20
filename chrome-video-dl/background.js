// Vidéo DL — service worker : repère les flux vidéo demandés par les pages et lance les téléchargements.
importScripts('common.js');

const FILE_EXT = /\.(mp4|webm|m4v|mov|flv|mkv)$/i;
const SKIP = /preview|thumb|\/ads?\/|vast|doubleclick|googlesyndication|googlevideo\.com|\.ts$|\.m4s$/i;
const MIN_FILE = 400 * 1024;          // ignore les petits clips (aperçus, pubs)

const cache = new Map();              // tabId → Promise<{ page, items: [] }>

function getTab(tabId) {
  if (!cache.has(tabId)) {
    const key = 'tab_' + tabId;
    cache.set(tabId, chrome.storage.session.get(key).then((r) => r[key] || { page: '', items: [] }));
  }
  return cache.get(tabId);
}

function saveTab(tabId, st) {
  cache.set(tabId, Promise.resolve(st));
  chrome.storage.session.set({ ['tab_' + tabId]: st });
  const n = st.items.length;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1f6fd1' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

function clearTab(tabId, page) {
  saveTab(tabId, { page: page || '', items: [] });
}

// ------------------------------------------------------------------ détection

chrome.webRequest.onHeadersReceived.addListener(async (d) => {
  if (d.tabId < 0 || d.statusCode >= 400) return;
  if (d.initiator && d.initiator.startsWith('chrome-extension://')) return;
  let u;
  try { u = new URL(d.url); } catch { return; }
  if (SKIP.test(d.url)) return;

  const h = {};
  for (const x of d.responseHeaders || []) h[x.name.toLowerCase()] = x.value || '';
  const ct = (h['content-type'] || '').split(';')[0].trim().toLowerCase();

  let kind = null;
  if (/\.m3u8$/i.test(u.pathname) || ct.includes('mpegurl')) kind = 'hls';
  else if (/\.mpd$/i.test(u.pathname) || ct === 'application/dash+xml') kind = 'dash';
  else if (FILE_EXT.test(u.pathname) || ct.startsWith('video/')) kind = 'file';
  if (!kind) return;

  let size = 0;
  const cr = /\/(\d+)\s*$/.exec(h['content-range'] || '');
  if (cr) size = +cr[1];
  else if (d.statusCode === 200) size = +h['content-length'] || 0;
  if (kind === 'file' && size && size < MIN_FILE) return;

  // URL sans les paramètres de plage (certains lecteurs ajoutent &range=…)
  const key = d.url.replace(/([?&])(range|bytestart|byteend)=[^&]*/gi, '$1').replace(/[?&]+$/, '');

  const st = await getTab(d.tabId);
  const old = st.items.find((x) => x.key === key);
  if (old) {
    if (size > (old.size || 0)) { old.size = size; saveTab(d.tabId, st); }
    return;
  }
  const ext = kind === 'file'
    ? ((FILE_EXT.exec(u.pathname) || [])[1] || (ct.split('/')[1] || 'mp4')).toLowerCase()
    : kind;
  st.items.push({ key, url: d.url, kind, size, ext, initiator: d.initiator || '', t: Date.now() });
  saveTab(d.tabId, st);
}, { urls: ['<all_urls>'] }, ['responseHeaders']);

// Nouvelle page (hors simple changement d'ancre) : on repart de zéro
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const st = await getTab(tabId);
  const strip = (s) => { try { const u = new URL(s); return u.origin + u.pathname + u.search; } catch { return s; } };
  if (strip(st.page) !== strip(info.url)) clearTab(tabId, info.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId);
});

// ------------------------------------------------------------------ en-têtes Referer / Origin

/** Referer attendu par le serveur vidéo : la page, ou l'origine du lecteur s'il est dans une iframe. */
function refererFor(item, pageUrl) {
  try {
    const pageOrigin = new URL(pageUrl).origin;
    if (!item.initiator || item.initiator === pageOrigin) return pageUrl;
    return item.initiator + '/';
  } catch {
    return item.initiator ? item.initiator + '/' : '';
  }
}

function ruleId(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) | 0;
  return (Math.abs(h) % 1000000) * 2 + 1;
}

/** Ajoute Referer/Origin aux requêtes de l'extension (et des téléchargements) vers ces serveurs. */
async function setHeaders(urls, referer) {
  if (!referer) return;
  const origin = new URL(referer).origin;
  const hosts = [...new Set(urls.map((x) => new URL(x).hostname))];
  const add = [], remove = [];
  for (const host of hosts) {
    const id = ruleId(host);
    const action = {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'referer', operation: 'set', value: referer },
        { header: 'origin', operation: 'set', value: origin },
      ],
    };
    const types = ['xmlhttprequest', 'media', 'other'];
    remove.push(id, id + 1);
    add.push({ id, priority: 1, action, condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], resourceTypes: types } });
    add.push({ id: id + 1, priority: 1, action, condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: types } });
  }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: remove, addRules: add });
}

// ------------------------------------------------------------------ messages du popup

async function probe(item, referer) {
  await setHeaders([item.url], referer);
  const r = await fetch(item.url, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (!text.startsWith('#EXTM3U')) throw new Error('playlist illisible');
  if (/#EXT-X-STREAM-INF/.test(text)) return { master: true, variants: parseMaster(text, r.url) };
  return {
    master: false,
    duration: hlsDuration(text),
    drm: /#EXT-X-KEY:[^\n]*METHOD=SAMPLE-AES|KEYFORMAT="(?!identity)/.test(text),
  };
}

async function startDownload({ item, variant, tabId, title, pageUrl }) {
  const referer = refererFor(item, pageUrl);
  const name = safeName(title);
  if (item.kind === 'file') {
    const ext = item.ext === 'webm' ? 'webm' : item.ext === 'mov' ? 'mov' : 'mp4';
    const job = { mode: 'file', url: item.url, title: name, ext, referer, pageUrl, tabId };
    // D'abord le gestionnaire de téléchargements de Chrome (rapide, reprise possible) ;
    // s'il est refusé (serveur qui exige le Referer), repli sur la page de téléchargement.
    const dlId = await chrome.downloads.download({ url: item.url, filename: name + '.' + ext, conflictAction: 'uniquify' });
    await chrome.storage.session.set({ ['direct_' + dlId]: job });
    return { ok: true, mode: 'direct' };
  }
  // HLS : assemblé dans une page dédiée (fetch des segments + conversion MP4)
  await openJob({ mode: 'hls', url: variant || item.url, title: name, referer, pageUrl }, tabId);
  return { ok: true, mode: 'hls' };
}

async function openJob(job, tabId) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await chrome.storage.session.set({ ['job_' + id]: job });
  await setHeaders([job.url], job.referer);
  const opts = { url: 'download.html#' + id, active: true };
  try { await chrome.tabs.get(tabId); opts.openerTabId = tabId; } catch {}
  await chrome.tabs.create(opts);
}

chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current === 'in_progress') return;
  const key = 'direct_' + d.id;
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) return;
  chrome.storage.session.remove(key);
  if (d.state.current !== 'interrupted') return;
  const [info] = await chrome.downloads.search({ id: d.id });
  const err = info && info.error ? info.error : '';
  if (err === 'USER_CANCELED') return;
  chrome.downloads.erase({ id: d.id }).catch(() => {});
  await openJob(job, job.tabId);       // nouvel essai avec Referer / cookies
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (msg.cmd === 'list') {
      const st = await getTab(msg.tabId);
      return { items: st.items };
    }
    if (msg.cmd === 'probe') return await probe(msg.item, refererFor(msg.item, msg.pageUrl));
    if (msg.cmd === 'download') return await startDownload(msg);
    if (msg.cmd === 'headers') { await setHeaders(msg.urls, msg.referer); return { ok: true }; }
    if (msg.cmd === 'clear') { clearTab(msg.tabId, msg.pageUrl); return { ok: true }; }
    throw new Error('commande inconnue');
  })().then(reply, (e) => reply({ error: e.message || String(e) }));
  return true;
});
