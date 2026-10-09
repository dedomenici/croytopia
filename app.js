/* CROYTOPIA prototype – vanilla JS, no build step. */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64d = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64e = u => btoa(String.fromCharCode(...new Uint8Array(u)));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();
// Search normalisation: case, accents, and iOS "smart" quotes/apostrophes (Queen’s == Queen's == Queens).
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘`´'"“”]/g, '').replace(/\s+/g, ' ').trim();
const KEY_STORE = 'croytopia.key.v1';
// Base map: Esri World Imagery (satellite) + Esri reference labels so place names remain.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const SAT_ATTR = 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community · Labels © Esri';
function addBaseLayers(m) {
  L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, className: 'sat-tiles', attribution: SAT_ATTR }).addTo(m);
  L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, className: 'label-tiles', pane: 'overlayPane' }).addTo(m);
}

let INDEX = null;            // public cities index
let KEY = null;              // AES-GCM CryptoKey
let CITY = null;             // decrypted city data
let map, layer, markers = new Map();
const state = { q: '', tags: new Set(), view: 'map' };

/* ---------- Password gate (hash compare + AES-GCM decrypt) ---------- */
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function deriveKey(pw) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64d(INDEX.kdf.salt), iterations: INDEX.kdf.iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt']);
}
async function decryptJSON(url) {
  const box = await (await fetch(asset(url), { cache: 'no-cache' })).json();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(box.iv) }, KEY, b64d(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function tryStoredKey() {
  const raw = localStorage.getItem(KEY_STORE);
  if (!raw) return false;
  try {
    KEY = await crypto.subtle.importKey('raw', b64d(raw), 'AES-GCM', false, ['decrypt']);
    await decryptJSON(INDEX.cities[0].data);   // verify still valid
    return true;
  } catch { localStorage.removeItem(KEY_STORE); KEY = null; return false; }
}
function initGate() {
  const form = $('#gate-form'), pw = $('#gate-pw'), msg = $('#gate-msg');
  pw.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const val = pw.value.trim().toUpperCase();
    msg.textContent = 'Checking…';
    if (await sha256Hex(val) !== INDEX.gate.sha256) {
      msg.textContent = 'Wrong password'; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
      pw.select(); return;
    }
    try {
      KEY = await deriveKey(val);
      await decryptJSON(INDEX.cities[0].data);
      localStorage.setItem(KEY_STORE, b64e(await crypto.subtle.exportKey('raw', KEY)));
      msg.textContent = ''; pw.value = '';
      enterApp();
    } catch (err) { console.error(err); msg.textContent = 'Could not unlock data'; }
  });
}

/* ---------- Routing ---------- */
// BASE = deploy path prefix from <base href> ("/" locally, "/croytopia/" on GitHub Pages)
const BASE = new URL(document.baseURI).pathname.replace(/\/?$/, '/');
const asset = p => BASE + String(p).replace(/^\/+/, '');
function citySlugFromPath() {
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  return p.replace(/^\/+|\/+$/g, '').split('/')[0].replace(/\.html$/, '').replace(/^(index|404|200)$/, '') || '';
}
async function enterApp() {
  $('#gate').hidden = true; $('#app').hidden = false;
  const slug = citySlugFromPath();
  const city = INDEX.cities.find(c => c.slug === slug && c.status === 'live');
  if (!city) return showCities();
  await loadCity(city);
}
function showCities() {
  $$('.view').forEach(v => v.hidden = true);
  $('.search').hidden = true; $('.tabbar').hidden = true;
  const v = $('#view-cities'); v.hidden = false;
  v.innerHTML = `<h2>Choose a city</h2><p class="muted">Each city gets its own “-topia”: a map of personal memories of places, told on video.</p>` +
    INDEX.cities.map(c => c.status === 'live'
      ? `<a class="city" href="${BASE}${c.slug}" data-slug="${c.slug}"><strong>${esc(c.brand)}</strong>${esc(c.name)} · ${esc(c.blurb || '')}</a>`
      : `<div class="city soon" aria-disabled="true"><strong>${esc(c.brand)}</strong>${esc(c.name)} · coming soon (example)</div>`).join('');
  $$('a.city', v).forEach(a => a.addEventListener('click', e => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); enterApp(); }));
}
window.addEventListener('popstate', () => { if (KEY) enterApp(); });

/* ---------- City ---------- */
async function loadCity(c) {
  $('.search').hidden = false; $('.tabbar').hidden = false; $('#view-cities').hidden = true;
  CITY = await decryptJSON(c.data);
  CITY.byId = Object.fromEntries(CITY.videos.map(v => [v.id, v]));
  CITY.videos.forEach(v => {
    v._hay = norm([v.title, v.place, v.name, v.blurb, v.description, v.transcript, v.tags.map(t => t.t).join(' ')].join(' \n '));
  });
  document.title = `${CITY.city.brand} — prototype`;
  initMap(); bindUI(); render(); setView('map');
  if (pinStyle.live) setCrazy(true);
}

/* ---------- Filtering ---------- */
function matches(v) {
  for (const t of state.tags) if (!v.tags.some(x => x.t === t)) return false;
  if (!state.q) return true;
  return state.q.split(/\s+/).filter(Boolean).every(w => v._hay.includes(w));
}
function visibleVideos() { return CITY.videos.filter(matches); }
function snippet(v) {
  if (!state.q || !v.transcript) return '';
  const w = state.q.split(/\s+/).filter(Boolean)[0]; const i = v.transcript.toLowerCase().indexOf(w);
  if (i < 0) return '';
  const s = Math.max(0, i - 50), e = Math.min(v.transcript.length, i + w.length + 70);
  return (s ? '…' : '') + highlight(v.transcript.slice(s, e)) + (e < v.transcript.length ? '…' : '');
}
function highlight(text) {
  let out = esc(text);
  state.q.split(/\s+/).filter(w => w.length > 1).forEach(w => {
    out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  });
  return out;
}

/* ---------- Pin style (thumbnail / name / description), saved in localStorage ---------- */
const PS_KEY = 'croytopia.pinStyle.v1';
let pinStyle = (() => { try { return { thumb: true, name: true, desc: false, live: false, ...JSON.parse(localStorage.getItem(PS_KEY) || '{}') }; } catch { return { thumb: true, name: true, desc: false, live: false }; } })();
function savePinStyle() { localStorage.setItem(PS_KEY, JSON.stringify(pinStyle)); }

// Crop YouTube's 4:3 hqdefault (vertical clips are pillarboxed in it) so only the picture fills a box (cover).
function thumbStyle(v, W, H) {
  const a = v.width && v.height ? v.width / v.height : 9 / 16;      // video aspect
  const f = Math.min(1, a * 360 / 480);                              // picture width as a fraction of the thumbnail
  let imgW = Math.max(W / f, H / 0.75);                              // cover W (picture) and H (full height)
  return `background-image:url(https://i.ytimg.com/vi/${v.id}/hqdefault.jpg);background-size:${imgW.toFixed(1)}px auto;background-position:center`;
}

/* ---------- Map (one pin per clip) ---------- */
let selectedVideo = null;
function initMap() {
  if (map) { map.remove(); markers.clear(); }
  if (typeof crazy !== 'undefined') { crazy.layer = null; crazy.markers.clear(); crazy.on = false; }
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView(CITY.city.center, CITY.city.zoom);
  addBaseLayers(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  // Clips sharing a place get a small ring offset so every clip has its own tappable pin.
  const byPlace = {};
  CITY.videos.forEach(v => (byPlace[v.placeId] ||= []).push(v));
  Object.values(byPlace).forEach(list => list.forEach((v, i) => {
    let lat = v.lat, lng = v.lng;
    if (list.length > 1) { const ang = 2 * Math.PI * i / list.length, r = 0.00018; lat += r * Math.cos(ang); lng += r * Math.sin(ang) / Math.cos(lat * Math.PI / 180); }
    const m = L.marker([lat, lng], { keyboard: true, title: [v.name, v.place].filter(Boolean).join(' · '), alt: v.place, riseOnHover: true });
    m.on('click', () => openPlayer(v.id));
    markers.set(v.id, m);
  }));
  playIntro();

}
// Intro: start on all of London, then fly in to fit every pin (jump if the user prefers reduced motion).
let introTimer;
function playIntro() {
  clearTimeout(introTimer); map.stop?.();
  const pinBounds = L.latLngBounds(CITY.videos.map(v => [v.lat, v.lng]));
  const fitOpts = { padding: [40, 40], maxZoom: 16 };
  const I = window.__croytopiaIntro = { state: 'start', from: null, to: null, runs: (window.__croytopiaIntro?.runs || 0) + 1 };
  map.setView([51.5072, -0.1276], 10, { animate: false });            // Greater London
  I.from = map.getZoom();
  const done = () => { I.state = 'done'; I.to = map.getZoom(); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { I.mode = 'jump'; map.fitBounds(pinBounds, { ...fitOpts, animate: false }); done(); return; }
  I.mode = 'fly';
  introTimer = setTimeout(() => { I.state = 'flying'; map.once('moveend', done); map.flyToBounds(pinBounds, { ...fitOpts, duration: 2.5, easeLinearity: 0.2 }); }, 600);
}
// Logo = back to the start: close video/panels, clear search + filters, replay the intro.
// After a search settles (or on Enter): on the map, zoom to the matching pins; say so when nothing matches.
function fitToResults(fromEnter) {
  if (!CITY || !map) return;
  const vis = visibleVideos();
  if (!vis.length) { if (state.q || state.tags.size) toast(`No memories match “${$('#q').value.trim()}”`); return; }
  if (state.view === 'map' && (state.q || state.tags.size) && vis.length < CITY.videos.length)
    map.flyToBounds(L.latLngBounds(vis.map(v => [v.lat, v.lng])), { padding: [60, 60], maxZoom: 17, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.8 });
  else if (fromEnter && state.view !== 'map') $('#view-' + state.view).scrollTop = 0;
}
let toastT;
function toast(msg) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => el.hidden = true, 2200); }

function resetToStart() {
  closePlayer(); closeAdd();
  $('#pinstyle-panel').hidden = true; $('#pinstyle-btn').setAttribute('aria-expanded', 'false');
  $('#q').value = ''; state.q = ''; state.tags.clear();
  setView('map'); render(); playIntro();
}

function pinHTML(v) {
  const S = pinStyle.thumb ? 42 : 18;
  const dot = pinStyle.thumb ? `<span class="pth" style="width:${S}px;height:${S}px;${thumbStyle(v, S, S)}"></span>` : `<span class="pdot"></span>`;
  const lines = [];
  if (pinStyle.name && v.name) lines.push(`<b>${esc(v.name)}</b>`);
  if (pinStyle.desc && v.blurb) lines.push(`<i>${esc(v.blurb)}</i>`);
  return `<div class="vpin ${selectedVideo === v.id ? 'sel' : ''}" style="--s:${S}px">${dot}${lines.length ? `<span class="plbl">${lines.join('')}</span>` : ''}</div>`;
}
function renderMarkers(vis) {
  layer.clearLayers();
  vis.forEach(v => {
    const m = markers.get(v.id); if (!m) return;
    m.setIcon(L.divIcon({ className: 'vpin-wrap', iconSize: [0, 0], iconAnchor: [0, 0], html: pinHTML(v) }));
    m.setZIndexOffset(selectedVideo === v.id ? 3000 : 0);
    layer.addLayer(m);
  });
}


/* ---------- Crazy mode: clips play at once on the map as tiny muted looping players ----------
   Many simultaneous YouTube iframes are heavy (each is a full player, ~decoder + network stream).
   Strategy: only clips whose pin is inside the visible map get a player, nearest the map centre first,
   capped at CRAZY_MAX (lower on phones); the rest show their cropped thumbnail with a neon pulse.
   Re-evaluated on pan/zoom; players that stay in the live set are kept (not reloaded).
   Paused (iframes removed) while the full player is open or another view is shown. */
const CRAZY_MAX = matchMedia('(pointer:coarse)').matches ? 6 : 12;
const crazy = { on: false, layer: null, markers: new Map(), live: new Set(), frames: new Map(), states: new Map() };
function crazyMini(v, live) {
  const W = 54, H = 96, a = v.width && v.height ? v.width / v.height : 9 / 16;
  // Render the player at 3.5x and scale down: YouTube lays out its UI for the larger size, then we crop "cover".
  const k = 3.5, BW = W * k, BH = H * k; let fw, fh; if (BW / BH > a) { fw = BW; fh = BW / a; } else { fh = BH; fw = BH * a; }
  const inner = live
    ? `<iframe class="cz-frame" data-vid="${v.id}" tabindex="-1" aria-hidden="true" style="width:${Math.ceil(fw)}px;height:${Math.ceil(fh)}px;left:${((BW - fw) / 2 / k).toFixed(1)}px;top:${((BH - fh) / 2 / k).toFixed(1)}px;transform:scale(${(1 / k).toFixed(4)})"
        src="https://www.youtube-nocookie.com/embed/${v.id}?autoplay=1&mute=1&controls=0&loop=1&playlist=${v.id}&playsinline=1&rel=0&disablekb=1&iv_load_policy=3&fs=0&modestbranding=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}"
        allow="autoplay; encrypted-media"></iframe>`
    : `<span class="cz-still" style="${thumbStyle(v, W, H)}"></span>`;
  return `<div class="cz ${live ? 'live' : 'still'}" style="--w:${W}px;--h:${H}px" aria-label="${esc([v.name, v.place].filter(Boolean).join(' · '))}">
    <div class="cz-clip">${inner}</div><span class="cz-tap"></span>${pinStyle.name && v.name ? `<span class="cz-name">${esc(v.name)}</span>` : ''}${pinStyle.desc && v.blurb ? `<span class="plbl cz-desc"><i>${esc(v.blurb)}</i></span>` : ''}</div>`;
}
function crazyRefresh() {
  if (!crazy.on || !map) return;
  const paused = !$('#player').hidden || state.view !== 'map';
  const vis = visibleVideos(), b = map.getBounds().pad(-0.02), c = map.getCenter();
  const want = new Set(paused ? [] : vis.filter(v => b.contains(crazy.markers.get(v.id)?.getLatLng() || [v.lat, v.lng]))
    .sort((x, y) => c.distanceTo(crazy.markers.get(x.id).getLatLng()) - c.distanceTo(crazy.markers.get(y.id).getLatLng()))
    .slice(0, CRAZY_MAX).map(v => v.id));
  crazy.layer.clearLayers();
  vis.forEach(v => {
    const m = crazy.markers.get(v.id); if (!m) return;
    const live = want.has(v.id);
    if (!m._czInit || m._czLive !== live) {
      m.setIcon(L.divIcon({ className: 'vpin-wrap', iconSize: [0, 0], iconAnchor: [0, 0], html: crazyMini(v, live) }));
      m._czInit = true; m._czLive = live;
    }
    m.setZIndexOffset(live ? 1000 : 0);
    crazy.layer.addLayer(m);
  });
  crazy.live = want;
  const inView = vis.filter(v => b.contains(crazy.markers.get(v.id).getLatLng())).length;
  $('#crazy-note').hidden = false;
  $('#crazy-note').textContent = paused ? 'Crazy mode paused' : `${want.size} playing · ${Math.max(0, inView - want.size)} more in view (max ${CRAZY_MAX} at once – zoom in to play others) · muted`;
  // forget state for removed iframes
  for (const [w, id] of crazy.frames) if (!want.has(id)) { crazy.frames.delete(w); crazy.states.delete(id); }
  requestAnimationFrame(() => $$('.cz-frame').forEach(f => {
    if (f._czListen) return; f._czListen = true;
    f.addEventListener('load', () => { crazy.frames.set(f.contentWindow, f.dataset.vid); f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'cz', channel: 'widget' }), '*'); });
  }));
}
function setCrazy(on) {
  crazy.on = on;
  $('#crazy-btn').setAttribute('aria-pressed', String(on)); $('#crazy-btn').classList.toggle('on', on);
  if (on) {
    if (!crazy.layer) {
      crazy.layer = L.layerGroup();
      markers.forEach((pm, id) => {
        const m = L.marker(pm.getLatLng(), { keyboard: true, title: pm.options.title, alt: pm.options.alt });
        m.on('click', () => openPlayer(id)); crazy.markers.set(id, m);
      });
      map.on('moveend zoomend', crazyRefresh);
    }
    map.removeLayer(layer); crazy.layer.addTo(map); crazyRefresh();
  } else {
    if (crazy.layer) { crazy.layer.clearLayers(); map.removeLayer(crazy.layer); crazy.markers.forEach(m => { m._czInit = false; }); }
    crazy.frames.clear(); crazy.states.clear(); crazy.live = new Set();
    layer.addTo(map); $('#crazy-note').hidden = true; renderMarkers(visibleVideos());
  }
}
window.__croytopiaCrazy = crazy;   // read-only status for automated tests

/* ---------- Full-height vertical player (autoplay muted + tap to unmute) ---------- */
function tagChips(tags) {
  return `<div class="chips">${tags.map(t => `<button class="chip ${state.tags.has(t.t) ? 'on' : ''}" data-tag="${esc(t.t)}" data-type="${t.type}">${esc(t.t)}</button>`).join('')}</div>`;
}
const PL = { id: null, state: -1, muted: true, frame: null };
window.__croytopiaPlayer = PL;   // read-only status for automated tests
function sizeFrame() {
  const st = $('#pl-stage'), fr = PL.frame; if (!st || !fr) return;
  const v = CITY.byId[PL.id]; const a = v && v.width && v.height ? v.width / v.height : 9 / 16;
  const W = st.clientWidth, H = st.clientHeight;
  let w, h; if (W / H > a) { w = W; h = W / a; } else { h = H; w = H * a; }   // cover: fill stage, crop overflow, never letterbox
  Object.assign(fr.style, { width: Math.ceil(w) + 'px', height: Math.ceil(h) + 'px', left: Math.round((W - w) / 2) + 'px', top: Math.round((H - h) / 2) + 'px' });
}
function ytCommand(func, args = []) { PL.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); }
function updateUnmute() { const b = $('#pl-unmute'); b.hidden = !PL.muted; }
function openPlayer(id) {
  const v = CITY.byId[id]; if (!v) return;
  selectedVideo = id; PL.id = id; PL.state = -1; PL.muted = true;
  const origin = encodeURIComponent(location.origin);
  $('#pl-frame').innerHTML = `<iframe id="pl-iframe" src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&playsinline=1&rel=0&loop=1&playlist=${id}&enablejsapi=1&origin=${origin}" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  PL.frame = $('#pl-iframe');
  PL.frame.addEventListener('load', () => { PL.frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'croytopia', channel: 'widget' }), '*'); });
  const vis = visibleVideos(), i = vis.findIndex(x => x.id === id);
  $('#pl-prev').hidden = $('#pl-next').hidden = vis.length < 2 || i < 0;
  const tx = v.transcript || '', ex = tx.length > 320 ? tx.slice(0, 320).replace(/\s+\S*$/, '') + '…' : tx;
  $('#pl-info').innerHTML = `
    <button class="pl-info-close" aria-label="Close info">✕</button>
    <h2 id="pl-title">${esc(v.place)}</h2>${v.name ? `<p class="who">${esc(v.name)}</p>` : ''}
    <div class="label">Tags · auto-generated · tap to filter</div>${tagChips(v.tags)}
    ${v.description ? `<div class="label">Description (YouTube)</div><p class="desc">${esc(v.description)}</p>` : ''}
    ${ex ? `<div class="label">Transcript excerpt · YouTube auto-captions</div><p class="desc">“${highlight(ex)}”</p>` : ''}
    ${tx.length > 320 ? `<details class="tx"><summary>Full transcript</summary><p>${highlight(tx)}</p></details>` : ''}
    <p class="muted">${v.duration ? Math.round(v.duration) + 's · ' : ''}${esc(v.uploadDate || '')} · YouTube: ${esc(v.channel)}${v.legacy ? ' · from older map' : ''} · <a href="https://www.youtube.com/watch?v=${v.id}" target="_blank" rel="noopener">Open on YouTube</a></p>`;
  togglePlInfo(false);
  $('#player').hidden = false; document.body.classList.add('playing');
  updateUnmute(); requestAnimationFrame(sizeFrame);
  renderMarkers(vis); crazyRefresh();
}
function togglePlInfo(force) {
  const panel = $('#pl-info'), open = force ?? panel.hidden;
  panel.hidden = !open; $('#pl-info-btn').setAttribute('aria-expanded', String(open)); $('#pl-info-btn').classList.toggle('on', open);
  if (open) panel.scrollTop = 0;
}
function stepPlayer(d) { const vis = visibleVideos(); if (!vis.length) return; const i = vis.findIndex(x => x.id === PL.id); openPlayer(vis[(i + d + vis.length) % vis.length].id); }
function closePlayer() {
  if ($('#player').hidden) return;
  $('#player').hidden = true; $('#pl-frame').innerHTML = ''; PL.frame = null; PL.id = null; PL.state = -1;
  document.body.classList.remove('playing'); selectedVideo = null; if (CITY) { renderMarkers(visibleVideos()); crazyRefresh(); }
}
window.addEventListener('message', e => {
  let host = ''; try { host = new URL(e.origin).hostname; } catch {}
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
  let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (crazy.frames.has(e.source)) {
    const id = crazy.frames.get(e.source), st = d.event === 'onStateChange' ? d.info : d.info?.playerState;
    if (typeof st === 'number') crazy.states.set(id, st);
    return;
  }
  if (!PL.frame || e.source !== PL.frame.contentWindow) return;
  if (d.event === 'onStateChange') PL.state = d.info;
  if (d.event === 'infoDelivery' && d.info) {
    if ('playerState' in d.info) PL.state = d.info.playerState;
    if ('muted' in d.info) { PL.muted = PL.ytMuted = d.info.muted; updateUnmute(); }
  }
});
window.addEventListener('resize', sizeFrame);

/* ---------- List & patterns ---------- */
function renderList(vis) {
  const ul = $('#list');
  if (!vis.length) { ul.innerHTML = `<li class="empty">No memories match. Try another word or clear the tags.</li>`; return; }
  ul.innerHTML = vis.map(v => {
    const sn = snippet(v);
    return `<li class="card" data-vid="${v.id}" tabindex="0" role="button" aria-label="${esc(v.title)}">
      <span class="cthumb" style="${thumbStyle(v, 60, 106)}" role="img" aria-label=""></span>
      <div><h3>${esc(v.place)}</h3><p>${esc(v.name)}${v.legacy ? ' · older map' : ''}</p>
      ${sn ? `<p class="snip">“${sn}”</p>` : ''}
      ${tagChips(v.tags.slice(0, 4))}</div></li>`;
  }).join('');
}
function renderPatterns(vis) {
  const counts = {};
  vis.forEach(v => v.tags.forEach(t => { const k = t.type + '|' + t.t; counts[k] = (counts[k] || 0) + 1; }));
  const groups = { theme: 'Themes', era: 'Eras mentioned', place: 'Places & things mentioned', keyword: 'Frequent words' };
  const contrib = {}; vis.forEach(v => { if (v.name) contrib[v.name] = (contrib[v.name] || 0) + 1; });
  const bars = (entries, max, tagged = true) => `<div class="bars">${entries.map(([label, n]) =>
    `<button class="bar" ${tagged ? `data-tag="${esc(label)}"` : 'disabled'}><span>${esc(label)}</span><span class="track"><span class="fill" style="width:${Math.max(6, 100 * n / max)}%"></span></span><span class="n">${n}</span></button>`).join('')}</div>`;
  let html = `<h2>Patterns</h2><p class="note">Tags are <strong>auto-generated</strong> from YouTube titles and auto-captions using keyword rules (prototype). They can be wrong. Counts = number of videos${state.q || state.tags.size ? ' matching your current search/filters' : ''} (${vis.length}). Tap a bar to filter.</p>`;
  for (const [type, label] of Object.entries(groups)) {
    const e = Object.entries(counts).filter(([k]) => k.startsWith(type + '|')).map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!e.length) continue;
    html += `<h3>${label}</h3>` + bars(e, e[0][1]);
  }
  const ce = Object.entries(contrib).sort((a, b) => b[1] - a[1]);
  html += `<h3>Contributors</h3>` + bars(ce, ce[0]?.[1] || 1, false);
  $('#view-patterns').innerHTML = html;
}
function renderActiveTags() {
  $('#active-tags').innerHTML = [...state.tags].map(t => `<button class="chip on" data-tag="${esc(t)}" aria-label="Remove filter ${esc(t)}">${esc(t)} <span class="x">×</span></button>`).join('');
}
function render() {
  const vis = visibleVideos();
  $('#count').textContent = `${vis.length}/${CITY.videos.length}`;
  renderActiveTags(); renderMarkers(vis); renderList(vis); renderPatterns(vis); crazyRefresh();
}
function setView(v) {
  state.view = v;
  ['map', 'list', 'patterns'].forEach(x => $('#view-' + x).hidden = x !== v);
  $$('.tab[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === v); b.toggleAttribute('aria-current', b.dataset.view === v); });
  closePlayer(); crazyRefresh(); if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
}
function toggleTag(t) { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); closePlayer(); render(); }

/* ---------- UI bindings ---------- */
let bound = false;
function bindUI() {
  if (bound) return; bound = true;
  // Search: live as you type (input/keyup/composition/search-clear) and on Enter/Search key (form submit).
  const q = $('#q'); let t, fitT;
  const applySearch = (fit) => {
    const val = norm(q.value);
    if (val !== state.q) { state.q = val; render(); }
    clearTimeout(fitT);
    if (fit) fitToResults(true); else fitT = setTimeout(() => fitToResults(false), 900);
  };
  ['input', 'keyup', 'compositionend', 'search', 'change'].forEach(ev => q.addEventListener(ev, () => { clearTimeout(t); t = setTimeout(() => applySearch(false), 60); }));
  $('#search-form').addEventListener('submit', e => { e.preventDefault(); clearTimeout(t); applySearch(true); q.blur(); });
  $$('.tab[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#pl-close').addEventListener('click', closePlayer);
  $('#pl-info-btn').addEventListener('click', () => togglePlInfo());
  $('#pl-prev').addEventListener('click', () => stepPlayer(-1));
  $('#pl-next').addEventListener('click', () => stepPlayer(1));
  $('#pl-unmute').addEventListener('click', () => { ytCommand('unMute'); ytCommand('setVolume', [100]); ytCommand('playVideo'); PL.muted = false; updateUnmute(); });
  const setLive = on => { pinStyle.live = on; savePinStyle(); const cb = $('input[name=ps][value=live]'); if (cb) cb.checked = on; setCrazy(on); };
  $('.brand').addEventListener('click', e => { if (!CITY || citySlugFromPath() !== CITY.city.slug) return; e.preventDefault(); resetToStart(); });
  $('#crazy-btn').addEventListener('click', () => setLive(!pinStyle.live));
  const psBtn = $('#pinstyle-btn'), psPanel = $('#pinstyle-panel');
  psBtn.addEventListener('click', () => { psPanel.hidden = !psPanel.hidden; psBtn.setAttribute('aria-expanded', String(!psPanel.hidden)); });
  $$('input[name=ps]').forEach(cb => {
    cb.checked = !!pinStyle[cb.value];
    cb.addEventListener('change', () => {
      if (cb.value === 'live') return setLive(cb.checked);
      pinStyle[cb.value] = cb.checked; savePinStyle(); renderMarkers(visibleVideos());
      crazy.markers.forEach(m => { m._czInit = false; }); crazyRefresh();
    });
  });
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-tag]'); if (chip) { e.stopPropagation(); toggleTag(chip.dataset.tag); if (chip.classList.contains('bar')) setView('map'); return; }
    if (e.target.closest('.pl-info-close')) return togglePlInfo(false);
    const card = e.target.closest('.card[data-vid]');
    if (card) { const v = CITY.byId[card.dataset.vid]; setView('map'); map.setView([v.lat, v.lng], Math.max(map.getZoom(), 16)); openPlayer(v.id); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!$('#pl-info').hidden) return togglePlInfo(false); closePlayer(); closeAdd(); }
    if (e.key === 'Enter' && e.target.matches('.card')) e.target.click();
  });
  initAdd();
}

/* ---------- Mock "Add your video" ---------- */
let addMap, addPin;
function step(n) {
  $$('#add .step').forEach(s => s.hidden = +s.dataset.step !== n);
  $$('#steps li').forEach((li, i) => li.classList.toggle('on', i < n));
  if (n === 2) setTimeout(() => {
    if (!addMap) {
      addMap = L.map('add-map', { zoomControl: true }).setView(CITY.city.center, 15);
      addBaseLayers(addMap);
      addMap.on('click', e => setPin(e.latlng));
    }
    addMap.invalidateSize();
  }, 30);
}
function setPin(ll) {
  if (addPin) addPin.setLatLng(ll); else addPin = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="pin multi">＋</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(addMap);
  $('#add-pin-info').textContent = `Pin: ${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`; $('#next2').disabled = false;
}
function openAdd() { $('#add').hidden = false; step(1); }
function closeAdd() {
  $('#add').hidden = true; const v = $('#add-preview');
  if (v.src) { URL.revokeObjectURL(v.src); v.removeAttribute('src'); v.hidden = true; }
}
function initAdd() {
  $('#add-btn').addEventListener('click', openAdd);
  $('#add-close').addEventListener('click', closeAdd);
  $('#add-finish').addEventListener('click', closeAdd);
  $('#add-file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    const v = $('#add-preview'); v.src = URL.createObjectURL(f); v.hidden = false;
    v.onloadedmetadata = () => { $('#add-file-info').textContent = `${f.name} · ${(f.size / 1e6).toFixed(1)} MB · ${Math.round(v.duration)}s · ${v.videoHeight > v.videoWidth ? 'vertical ✓' : 'tip: vertical works best'} (stays on your device)`; };
    $('#next1').disabled = false;
  });
  $$('#add .next').forEach(b => b.addEventListener('click', () => step(+b.dataset.next)));
  $('#add-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return ($('#add-pin-info').textContent = 'Location not available');
    $('#add-pin-info').textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(p => { const ll = L.latLng(p.coords.latitude, p.coords.longitude); addMap.setView(ll, 17); setPin(ll); },
      () => $('#add-pin-info').textContent = 'Could not get location — tap the map instead', { enableHighAccuracy: true, timeout: 8000 });
  });
  const check = () => { $('#add-submit').disabled = !($('#add-name').value.trim() && $$('#add .c').every(c => c.checked)); };
  $('#add').addEventListener('input', check); $('#add').addEventListener('change', check);
  $('#add-submit').addEventListener('click', () => step(4));
}

/* ---------- Boot ---------- */
(async function boot() {
  INDEX = await (await fetch(asset('data/cities.json'), { cache: 'no-cache' })).json();
  if (await tryStoredKey()) enterApp(); else initGate();
})();
})();
