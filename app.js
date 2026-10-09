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
  initMap(); bindUI(); render(); setView('map'); ensurePlayerFrame();
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
let pinStyle = (() => { try { return { thumb: true, name: true, desc: false, ...JSON.parse(localStorage.getItem(PS_KEY) || '{}') }; } catch { return { thumb: true, name: true, desc: false }; } })();
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
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true, zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 120 }).setView(CITY.city.center, CITY.city.zoom);
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
// Tight fit: just enough padding that the pin markers themselves (and name labels) aren't cut off.
function tightFit(vids) {
  const r = pinStyle.thumb ? 25 : 13, label = (pinStyle.name || pinStyle.desc) ? (pinStyle.desc ? 150 : 56) : 0;
  return { bounds: L.latLngBounds(vids.map(v => markers.get(v.id)?.getLatLng() || [v.lat, v.lng])), opts: { paddingTopLeft: [r + 4, r + 4], paddingBottomRight: [r + 4 + label, r + 4], maxZoom: 18 } };
}
// Intro: start on all of London, then fly in to fit every pin (jump if the user prefers reduced motion).
let introTimer;
function playIntro() {
  clearTimeout(introTimer); map.stop?.();
  const { bounds: pinBounds, opts: fitOpts } = tightFit(CITY.videos);
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
function fitToResults(fromEnter, evenIfAll) {
  if (!CITY || !map) return;
  const vis = visibleVideos();
  if (!vis.length) { if (state.q || state.tags.size) toast(`No memories match${state.q ? ` “${$('#q').value.trim()}”` : ' these tags'}`); return; }
  if (state.view === 'map' && (evenIfAll || ((state.q || state.tags.size) && vis.length < CITY.videos.length))) {
    const { bounds, opts } = tightFit(vis);
    map.invalidateSize();
    map.flyToBounds(bounds, { ...opts, maxZoom: vis.length === 1 ? 17 : 18, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 0.8 });
  }
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


/* ---------- Full-height vertical player ----------
   YouTube iframe with controls=0 (no YouTube control bar), oversized so YouTube's own top/bottom overlays fall
   outside the screen, under a transparent tap layer + our own controls (mute, CC, seek, prev/next, Tags) and our
   own captions drawn from the auto-caption cues (timed via the IFrame API's currentTime). Sound on by default:
   we try unmuted autoplay from the tap; if the browser blocks it we fall back to muted autoplay + mute button. */
function tagChips(tags) {
  return `<div class="chips">${tags.map(t => `<button class="chip ${state.tags.has(t.t) ? 'on' : ''}" data-tag="${esc(t.t)}" data-type="${t.type}">${esc(t.t)}</button>`).join('')}</div>`;
}
const CC_KEY = 'croytopia.cc.v1';
const PL = { id: null, state: -1, muted: false, ytMuted: null, frame: null, time: 0, timeAt: 0, dur: 0, autoplay: '', cc: localStorage.getItem(CC_KEY) !== 'off', raf: 0, fallbackT: 0 };
window.__croytopiaPlayer = PL;   // read-only status for automated tests
const SPK = {
  on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' };
const OVERSCAN = 64;   // px pushed off-screen top and bottom to hide YouTube's title row / bottom overlays
function sizeFrame() {
  const st = $('#pl-stage'), fr = PL.frame; if (!st || !fr) return;
  const v = CITY.byId[PL.id]; const a = v && v.width && v.height ? v.width / v.height : 9 / 16;
  const W = st.clientWidth, H = st.clientHeight + 2 * OVERSCAN;
  let w, h; if (W / H > a) { w = W; h = W / a; } else { h = H; w = H * a; }   // cover: fill, crop overflow, never letterbox
  Object.assign(fr.style, { width: Math.ceil(w) + 'px', height: Math.ceil(h) + 'px', left: Math.round((W - w) / 2) + 'px', top: Math.round((st.clientHeight - h) / 2) + 'px' });
}
function ytCommand(func, args = []) { PL.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); }
function setMuted(m) {
  PL.muted = m; ytCommand(m ? 'mute' : 'unMute'); if (!m) ytCommand('setVolume', [100]);
  updateMuteBtn();
}
function updateMuteBtn() {
  const b = $('#pl-mute'); b.innerHTML = PL.muted ? SPK.off : SPK.on; b.classList.toggle('muted', PL.muted);
  b.setAttribute('aria-label', PL.muted ? 'Sound is off – turn on' : 'Sound is on – mute');
}
function updateCC() { const b = $('#pl-cc'); b.classList.toggle('on', PL.cc); b.setAttribute('aria-pressed', String(PL.cc)); if (!PL.cc) $('#pl-caption').innerHTML = ''; }
function curTime() { return PL.time + (PL.state === 1 && PL.timeAt ? (performance.now() - PL.timeAt) / 1000 : 0); }
function tick() {
  const v = CITY?.byId[PL.id]; if (!v) return;
  const t = curTime(), dur = PL.dur || v.duration || 0;
  if (dur) { $('#pl-bar').style.width = Math.min(100, 100 * t / dur) + '%'; $('#pl-progress').setAttribute('aria-valuenow', Math.round(100 * t / dur)); }
  if (PL.cc) {
    const cue = (v.cues || []).find(c => t >= c[0] && t < c[1] + 0.25);
    const html = cue ? `<span>${esc(cue[2])}</span>` : '';
    if ($('#pl-caption').innerHTML !== html) $('#pl-caption').innerHTML = html;
  }
  $('#pl-bigplay').hidden = !(PL.state === 2);
  PL.raf = requestAnimationFrame(tick);
}
// One persistent YouTube player, created (paused) when the city loads. A pin tap then sends loadVideoById +
// unMute + playVideo *synchronously inside the tap*, which is what lets browsers allow sound.
function ensurePlayerFrame() {
  if (PL.frame) return;
  const first = CITY.videos[0].id, origin = encodeURIComponent(location.origin);
  $('#pl-frame').innerHTML = `<iframe id="pl-iframe" src="https://www.youtube-nocookie.com/embed/${first}?autoplay=0&controls=0&playsinline=1&rel=0&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0&modestbranding=1&enablejsapi=1&origin=${origin}" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" tabindex="-1"></iframe>`;
  PL.frame = $('#pl-iframe'); PL.ready = false;
  PL.frame.addEventListener('load', () => { PL.frame?.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'croytopia', channel: 'widget' }), '*'); });
}
function openPlayer(id) {
  const v = CITY.byId[id]; if (!v) return;
  cancelAnimationFrame(PL.raf); clearTimeout(PL.fallbackT);
  Object.assign(PL, { id, state: -1, time: 0, timeAt: 0, dur: v.duration || 0, autoplay: 'trying-unmuted', tapAt: performance.now(), userToggled: false });
  selectedVideo = id;
  ensurePlayerFrame();
  if (PL.ready) {
    // inside the user's tap: switch video and ask for sound
    ytCommand('loadVideoById', [id, 0]); PL.muted = false; ytCommand('unMute'); ytCommand('setVolume', [100]); ytCommand('playVideo');
  } else { PL.pendingId = id; PL.muted = false; }
  // If it isn't playing with sound quickly, the browser blocked it: start muted (always allowed), then try sound once more.
  PL.fallbackT = setTimeout(() => { if (PL.state !== 1) { PL.autoplay = 'muted-fallback'; setMuted(true); ytCommand('playVideo'); } }, 1500);
  const vis = visibleVideos(), i = vis.findIndex(x => x.id === id);
  $('#pl-prev').hidden = $('#pl-next').hidden = vis.length < 2 || i < 0;
  $('#pl-info').innerHTML = `
    <button class="pl-info-close" aria-label="Close info">✕</button>
    <h2 id="pl-title">${esc(v.place)}</h2>${v.name ? `<p class="who">${esc(v.name)}</p>` : ''}
    <div class="label">Tags · auto-generated · tap to filter</div>${tagChips(v.tags)}
    ${v.description ? `<div class="label">Description (YouTube)</div><p class="desc">${esc(v.description)}</p>` : ''}
    ${v.transcript ? `<div class="label">Transcript · YouTube auto-captions</div><p class="tx-full">${highlight(v.transcript)}</p>` : ''}
    <p class="muted">${v.duration ? Math.round(v.duration) + 's · ' : ''}${esc(v.uploadDate || '')} · YouTube: ${esc(v.channel)}${v.legacy ? ' · from older map' : ''}</p>`;
  togglePlInfo(false);
  $('#pl-caption').innerHTML = ''; $('#pl-bar').style.width = '0';
  $('#player').hidden = false; document.body.classList.add('playing');
  updateMuteBtn(); updateCC(); sizeFrame(); PL.raf = requestAnimationFrame(tick);
  renderMarkers(vis);
}
function togglePlInfo(force) {
  const panel = $('#pl-info'), open = force ?? panel.hidden;
  panel.hidden = !open; $('#pl-info-btn').setAttribute('aria-expanded', String(open)); $('#pl-info-btn').classList.toggle('on', open);
  if (open) panel.scrollTop = 0;
}
function stepPlayer(d) { const vis = visibleVideos(); if (!vis.length) return; const i = vis.findIndex(x => x.id === PL.id); openPlayer(vis[(i + d + vis.length) % vis.length].id); }
function closePlayer() {
  if ($('#player').hidden) return;
  cancelAnimationFrame(PL.raf); clearTimeout(PL.fallbackT);
  ytCommand('pauseVideo'); $('#player').hidden = true; PL.id = null; PL.state = -1;
  document.body.classList.remove('playing'); selectedVideo = null; if (CITY) renderMarkers(visibleVideos());
}
window.addEventListener('message', e => {
  let host = ''; try { host = new URL(e.origin).hostname; } catch {}
  if (!/(^|\.)youtube(-nocookie)?\.com$/.test(host)) return;
  if (!PL.frame || e.source !== PL.frame.contentWindow) return;
  let d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
  if (d.event === 'onReady') {
    PL.ready = true; ytCommand('unloadModule', ['captions']); ytCommand('unloadModule', ['cc']);
    if (PL.pendingId && PL.id === PL.pendingId) { ytCommand('loadVideoById', [PL.pendingId, 0]); ytCommand('unMute'); ytCommand('playVideo'); }
    PL.pendingId = null;
  }
  if (!PL.id) return;   // player closed: ignore background events
  const setState = st => {
    if (st === 0) { ytCommand('seekTo', [0, true]); ytCommand('playVideo'); }   // loop
    if (st === PL.state) return;
    if (PL.state === 1) { PL.time = curTime(); }            // freeze interpolated time on pause
    PL.state = st; PL.timeAt = performance.now();
    if (st === 1) {
      ytCommand('unloadModule', ['captions']);
      if (PL.autoplay === 'trying-unmuted' && !PL.muted) PL.autoplay = 'unmuted';
      if (PL.autoplay === 'muted-fallback' && performance.now() - PL.tapAt < 4500) {
        PL.autoplay = 'unmute-after-start'; setMuted(false);
        setTimeout(() => { if (PL.autoplay === 'unmute-after-start') PL.autoplay = (PL.state === 1 && !PL.muted) ? 'unmuted-after-muted-start' : PL.autoplay; }, 1500);
      }
    }
    if (st === 2 && PL.autoplay === 'unmute-after-start') { PL.autoplay = 'muted (sound blocked)'; setMuted(true); ytCommand('playVideo'); }
  };
  if (d.event === 'onStateChange') setState(d.info);
  if (d.event === 'infoDelivery' && d.info) {
    if ('currentTime' in d.info) { PL.time = d.info.currentTime; PL.timeAt = performance.now(); }
    if ('duration' in d.info && d.info.duration) PL.dur = d.info.duration;
    if ('muted' in d.info) { PL.ytMuted = d.info.muted; if (d.info.muted !== PL.muted) { PL.muted = d.info.muted; updateMuteBtn(); if (PL.muted && PL.autoplay === 'trying-unmuted') PL.autoplay = 'muted-by-youtube'; } }
    if ('playerState' in d.info) setState(d.info.playerState);
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
  renderActiveTags(); renderMarkers(vis); renderList(vis); renderPatterns(vis);
}
function setView(v) {
  state.view = v;
  ['map', 'list', 'patterns'].forEach(x => $('#view-' + x).hidden = x !== v);
  $$('.tab[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === v); b.toggleAttribute('aria-current', b.dataset.view === v); });
  closePlayer(); if (v === 'map') setTimeout(() => map.invalidateSize(), 0);
}
function toggleTag(t) { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); closePlayer(); render(); setTimeout(() => fitToResults(false, true), 60); }

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
  $('#pl-mute').addEventListener('click', () => { setMuted(!PL.muted); if (PL.state !== 1) ytCommand('playVideo'); });
  $('#pl-cc').addEventListener('click', () => { PL.cc = !PL.cc; localStorage.setItem(CC_KEY, PL.cc ? 'on' : 'off'); updateCC(); });
  $('#pl-tap').addEventListener('click', () => {
    if (PL.state === 1 && PL.muted && /muted/.test(PL.autoplay) && !PL.userToggled) { PL.userToggled = true; setMuted(false); return; }  // first tap after a blocked autoplay = sound on
    if (PL.state === 1) ytCommand('pauseVideo'); else ytCommand('playVideo');
  });
  $('#pl-progress').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect(), f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), dur = PL.dur || CITY.byId[PL.id]?.duration || 0;
    if (dur) { ytCommand('seekTo', [f * dur, true]); PL.time = f * dur; PL.timeAt = performance.now(); }
  });
  $('.brand').addEventListener('click', e => { if (!CITY || citySlugFromPath() !== CITY.city.slug) return; e.preventDefault(); resetToStart(); });
  const psBtn = $('#pinstyle-btn'), psPanel = $('#pinstyle-panel');
  psBtn.addEventListener('click', () => { psPanel.hidden = !psPanel.hidden; psBtn.setAttribute('aria-expanded', String(!psPanel.hidden)); });
  $$('input[name=ps]').forEach(cb => {
    cb.checked = !!pinStyle[cb.value];
    cb.addEventListener('change', () => { pinStyle[cb.value] = cb.checked; savePinStyle(); renderMarkers(visibleVideos()); });
  });
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-tag]'); if (chip) { e.stopPropagation(); const bar = chip.classList.contains('bar'); if (bar) setView('map'); toggleTag(chip.dataset.tag); return; }
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
