/* CROYTOPIA prototype – vanilla JS, no build step. */
(() => {
'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Search normalisation: case, accents, and iOS "smart" quotes/apostrophes (Queen’s == Queen's == Queens).
// localStorage can throw (Safari private mode, quota, disabled storage): never let it break the app.
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = k => { try { localStorage.removeItem(k); } catch {} };
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[’‘`´'"“”]/g, '').replace(/\s+/g, ' ').trim();
// Base map: Esri World Imagery (satellite) + Esri reference labels so place names remain.
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const SAT_ATTR = 'Imagery © <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community · Labels © Esri';
function addBaseLayers(m) {
  L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, className: 'sat-tiles', attribution: SAT_ATTR }).addTo(m);
  L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, className: 'label-tiles', pane: 'overlayPane' }).addTo(m);
}

let INDEX = null;            // public cities index
let CITY = null;             // city data
let map, layer, markers = new Map();
const state = { q: '', tags: new Set(), view: 'map' };

async function loadJSON(url) { return (await fetch(asset(url) + (String(url).includes('?') ? '&' : '?') + 'v=' + APP_VERSION, { cache: 'no-cache' })).json(); }

/* ---------- Routing ---------- */
// BASE = deploy path prefix from <base href> ("/" locally, "/croytopia/" on GitHub Pages)
const APP_VERSION = '9ba53e7700';   // replaced at build; appended to data fetches
const BASE = new URL(document.baseURI).pathname.replace(/\/?$/, '/');
const asset = p => BASE + String(p).replace(/^\/+/, '');
function citySlugFromPath() {
  let p = location.pathname;
  if (p.startsWith(BASE)) p = p.slice(BASE.length);
  return p.replace(/^\/+|\/+$/g, '').split('/')[0].replace(/\.html$/, '').replace(/^(index|404|200)$/, '') || '';
}
async function enterApp() {
  $('#app').hidden = false;
  const slug = citySlugFromPath();
  const city = INDEX.cities.find(c => c.slug === slug && c.status === 'live');
  if (!city) return showCities();
  await loadCity(city);
}
function showCities() {
  $$('.view').forEach(v => v.hidden = true);
  $('.tabbar').hidden = true;
  const v = $('#view-cities'); v.hidden = false;
  v.innerHTML = `<h2>Choose a city</h2><p class="muted">Each city gets its own “-topia”: a map of personal memories of places, told on video.</p>` +
    INDEX.cities.map(c => c.status === 'live'
      ? `<a class="city" href="${BASE}${c.slug}" data-slug="${c.slug}"><strong>${esc(c.brand)}</strong>${esc(c.name)} · ${esc(c.blurb || '')}</a>`
      : `<div class="city soon" aria-disabled="true"><strong>${esc(c.brand)}</strong>${esc(c.name)} · coming soon (example)</div>`).join('');
  $$('a.city', v).forEach(a => a.addEventListener('click', e => { e.preventDefault(); history.pushState({}, '', a.getAttribute('href')); enterApp(); }));
}
window.addEventListener('popstate', () => enterApp());

/* ---------- City ---------- */
async function loadCity(c) {
  $('.tabbar').hidden = false; $('#view-cities').hidden = true;
  CITY = await loadJSON(c.data);
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
let pinStyle = (() => { try { return { thumb: true, name: true, desc: false, ...JSON.parse(lsGet(PS_KEY) || '{}') }; } catch { return { thumb: true, name: true, desc: false }; } })();
function savePinStyle() { lsSet(PS_KEY, JSON.stringify(pinStyle)); }

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
  window.__croytopiaMap = map;
  { const ab = document.createElement('button'); ab.id = 'attr-btn'; ab.className = 'attr-btn'; ab.type = 'button'; ab.textContent = 'ⓘ'; ab.setAttribute('aria-label', 'Map credits'); ab.setAttribute('aria-expanded', 'false');
    ab.addEventListener('click', e => { e.stopPropagation(); const on = $('#view-map').classList.toggle('attr-open'); ab.setAttribute('aria-expanded', String(on)); });
    L.DomEvent.disableClickPropagation(ab); $('#view-map').appendChild(ab); map.on('click', () => { $('#view-map').classList.remove('attr-open'); ab.setAttribute('aria-expanded', 'false'); }); }
  addBaseLayers(map);
  L.control.zoom({ position: 'topright' }).addTo(map); addLocateControl(); map.on('move zoom', livePlace); 
  layer = L.layerGroup().addTo(map);
  // Clips sharing a place get a small ring offset so every clip has its own tappable pin.
  const byPlace = {};
  CITY.videos.forEach(v => (byPlace[v.placeId] ||= []).push(v));
  Object.values(byPlace).forEach(list => list.forEach((v, i) => {
    let lat = v.lat, lng = v.lng;
    if (list.length > 1) { const ang = 2 * Math.PI * i / list.length, r = 0.00018; lat += r * Math.cos(ang); lng += r * Math.sin(ang) / Math.cos(lat * Math.PI / 180); }
    const m = L.marker([lat, lng], { keyboard: true, title: [v.name, v.place].filter(Boolean).join(' · '), alt: v.place, riseOnHover: true });
    m.on('click', ev => openPlayer(v.id, (ev.originalEvent?.target?.closest('.vpin')?.querySelector('.pth,.pdot') || m.getElement())?.getBoundingClientRect()));
    markers.set(v.id, m);
  }));
  playIntro();

}
// Tight fit: just enough padding that the pin markers themselves (and name labels) aren't cut off.
// Map is full-screen under the floating header + toolbar, so pad by their heights. `loose` adds a margin (start view).
function chromeInsets() {
  const h = document.querySelector('.brand img').getBoundingClientRect(), t = document.querySelector('.tabbar').getBoundingClientRect();
  return { top: Math.round(h.bottom) + 2, bottom: Math.round(innerHeight - t.top) };   // pins may just kiss the logo's glow / toolbar edge
}
// Locate me: crosshair under the zoom buttons → pulsing neon dot + accuracy circle; graceful when denied / far away.
const ME = { marker: null, circle: null };
function addLocateControl() {
  const C = L.Control.extend({ options: { position: 'topright' }, onAdd() {
    const b = L.DomUtil.create('button', 'locate-btn'); b.type = 'button'; b.id = 'locate-btn'; b.setAttribute('aria-label', 'Show my location');
    b.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, 'click', locateMe); return b; } });
  map.addControl(new C());
}
function backToCity() { const { bounds, opts } = tightFit(CITY.videos, 'edge'); map.flyToBounds(bounds, { ...opts, duration: reduceMotion() ? 0 : 1.2 }); }
function locateMe() {
  const b = $('#locate-btn');
  if (!navigator.geolocation) return toast('Location isn’t available on this device');
  b.classList.add('busy');
  navigator.geolocation.getCurrentPosition(pos => {
    b.classList.remove('busy'); b.classList.add('on');
    const ll = L.latLng(pos.coords.latitude, pos.coords.longitude), acc = Math.min(pos.coords.accuracy || 50, 5000);
    if (!ME.marker) {
      ME.circle = L.circle(ll, { radius: acc, color: '#2ef2ce', weight: 1, opacity: .7, fillColor: '#2ef2ce', fillOpacity: .12, interactive: false }).addTo(map);
      ME.marker = L.marker(ll, { icon: L.divIcon({ className: 'me-dot', html: '<span class="me-pulse"></span><span class="me-core"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, keyboard: false, zIndexOffset: 2000 }).addTo(map);
    } else { ME.marker.setLatLng(ll); ME.circle.setLatLng(ll).setRadius(acc); }
    window.__croytopiaMe = { lat: ll.lat, lng: ll.lng, acc };
    const km = ll.distanceTo(L.latLng(CITY.city.center)) / 1000;
    if (km > 25) {
      map.flyTo(ll, 12, { duration: reduceMotion() ? 0 : 1.5 });
      toast(`You’re about ${Math.round(km)} km from ${CITY.city.name || 'Croydon'}`, { label: `Back to ${CITY.city.name || 'Croydon'}`, fn: backToCity });
    } else map.flyTo(ll, Math.max(map.getZoom(), 16), { duration: reduceMotion() ? 0 : 1.2 });
  }, err => {
    b.classList.remove('busy');
    toast(err.code === 1 ? 'Location permission denied — you can allow it in your browser settings' : 'Couldn’t get your location right now');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}
function tightFit(vids, loose = 0) {
  const r = pinStyle.thumb ? 25 : 13, label = (pinStyle.name || pinStyle.desc) ? (pinStyle.desc ? 150 : 56) : 0, c = chromeInsets();
  const bounds = L.latLngBounds(vids.map(v => markers.get(v.id)?.getLatLng() || [v.lat, v.lng]));
  // start view (loose === 'edge'): pin circles almost touch the logo, the toolbar and the screen sides (labels may run off the edge)
  if (loose === 'edge') return { bounds, opts: { paddingTopLeft: [r + 2, c.top + r + 2], paddingBottomRight: [r + 2, c.bottom + r + 2], maxZoom: 18 } };
  return { bounds, opts: { paddingTopLeft: [r + 4 + loose, c.top + r + 4 + loose], paddingBottomRight: [r + 4 + label + loose, c.bottom + r + 4 + loose], maxZoom: 18 } };
}
// Intro: start on all of London, then fly in to fit every pin (jump if the user prefers reduced motion).
let introTimer;
function playIntro() {
  clearTimeout(introTimer); map.stop?.();
  const { bounds: pinBounds, opts: fitOpts } = tightFit(CITY.videos, 'edge');
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
function toast(msg, action) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false; el.classList.toggle('has-action', !!action); clearTimeout(toastT);
  if (action) { const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label; b.onclick = () => { el.hidden = true; action.fn(); }; el.append(' ', b); }
  toastT = setTimeout(() => el.hidden = true, action ? 7000 : 2200);
}

// Search pop-up (magnifier in the toolbar). Focus is set synchronously inside the tap so mobile keyboards open.
function openSearch() {
  closePlayer(); closeAbout();
  $('#search-pop').hidden = false; $('#search-btn').setAttribute('aria-expanded', 'true'); $('#search-btn').classList.add('active');
  const q = $('#q'); q.focus(); q.select?.();
}
function closeSearch() {
  if ($('#search-pop').hidden) return;
  $('#search-pop').hidden = true; $('#q').blur(); $('#search-btn').setAttribute('aria-expanded', 'false'); $('#search-btn').classList.remove('active');
}
// About page with the trailer. The (paused) trailer player is created when About opens; tapping the poster sends
// playVideo synchronously inside the tap (same trick as the main player) so it can start with sound.
const TRAILER = 'YlS_ra8Ji9w';
const TR = { frame: null, ready: false, wantPlay: false };
function openAbout() {
  closePlayer(); closeSearch(); $('#about').hidden = false; $('#about').scrollTop = 0; $('#about-btn').classList.add('active');
  if (!TR.frame) {
    const f = document.createElement('iframe');
    f.id = 'about-iframe'; f.title = 'Croytopia Trailer'; f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen'; f.allowFullscreen = true;
    f.src = `https://www.youtube-nocookie.com/embed/${TRAILER}?autoplay=0&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
    f.addEventListener('load', () => f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'trailer', channel: 'widget' }), '*'));
    $('#about-video').prepend(f); TR.frame = f; TR.ready = false;
  }
  $('#about-trailer').hidden = false;
}
function trCmd(func, args = []) { TR.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); }
function closeAbout() {
  if ($('#about').hidden) return;
  $('#about').hidden = true; $('#about-btn').classList.remove('active');
  if (TR.frame) { TR.frame.remove(); TR.frame = null; TR.ready = false; }   // stop the trailer
}
function playTrailer() {
  $('#about-trailer').hidden = true;
  if (TR.ready) { trCmd('unMute'); trCmd('playVideo'); }
  else if (TR.frame) { TR.frame.src = TR.frame.src.replace('autoplay=0', 'autoplay=1'); }   // not ready yet: let YouTube autoplay it
}
window.addEventListener('message', e => {
  if (!TR.frame || e.source !== TR.frame.contentWindow) return;
  let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.event === 'onReady') TR.ready = true;
  if (d.event === 'infoDelivery' && d.info && 'playerState' in d.info) TR.state = d.info.playerState;
});
window.__croytopiaTrailer = TR;

function resetToStart() {
  closePlayer(); closeAdd(); closeSearch(); closeAbout();
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
// Animated pins: ONE persistent YouTube player (created once, reused via loadVideoById so an audio unlock carries over)
// floats in a round window over the current pin, cycling north → south through the shown pins, 5 s each, then looping.
// Sound follows the map's volume button (default muted); unmuting happens inside that button's tap.
const LIVE = { idx: -1, id: null, timer: null, wrap: null, frame: null, ready: false, state: -1, pending: null };
const SND_KEY = 'croytopia.pinsound';
let pinSound = false;   // animated pins always play muted (map volume button removed)
function liveCmd(func, args = []) { LIVE.frame?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*'); }
function liveEnsure() {
  if (LIVE.frame) return;
  const w = document.createElement('div'); w.className = 'live-win'; w.hidden = true;
  const f = document.createElement('iframe'); f.className = 'pth-live'; f.tabIndex = -1; f.setAttribute('aria-hidden', 'true'); f.allow = 'autoplay';
  f.src = `https://www.youtube-nocookie.com/embed/${CITY.videos[0].id}?autoplay=0&mute=1&controls=0&playsinline=1&disablekb=1&fs=0&rel=0&iv_load_policy=3&cc_load_policy=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
  f.addEventListener('load', () => f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'live', channel: 'widget' }), '*'));
  w.appendChild(f); $('#view-map').appendChild(w); LIVE.wrap = w; LIVE.frame = f;
}
function livePlace() {
  if (!LIVE.wrap || !LIVE.id) return;
  const host = markers.get(LIVE.id)?.getElement()?.querySelector('.pth'); if (!host) { LIVE.wrap.hidden = true; return; }
  const r = host.getBoundingClientRect(), m = $('#view-map').getBoundingClientRect();
  Object.assign(LIVE.wrap.style, { left: r.left - m.left + 'px', top: r.top - m.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  LIVE.frame.style.transform = `scale(${r.width / 320 * 1.05}) translate(-50%,-50%)`;   // big player scaled down → YouTube's centre icon is tiny
  LIVE.wrap.hidden = false;
}
function liveLoad(id) {
  LIVE.id = id; LIVE.state = -1; window.__croytopiaLive = id; livePlace();
  if (!LIVE.ready) { LIVE.pending = id; return; }
  liveCmd(pinSound ? 'unMute' : 'mute'); liveCmd('loadVideoById', [id, 0]); liveCmd('playVideo');
  if (pinSound) { clearTimeout(LIVE.fb); LIVE.fb = setTimeout(() => { if (LIVE.id === id && LIVE.state !== 1) soundBlocked(); }, 1200); }
}
function soundBlocked() { pinSound = false; lsSet(SND_KEY, 'off'); updateSoundBtn(); liveCmd('mute'); liveCmd('playVideo'); window.__croytopiaSound = 'blocked → muted'; }
function liveStop() { clearTimeout(LIVE.fb); clearTimeout(LIVE.timer); LIVE.timer = null; LIVE.id = null; window.__croytopiaLive = null; if (LIVE.wrap) { LIVE.wrap.hidden = true; liveCmd('pauseVideo'); } }
function liveTick() {
  const order = visibleVideos().map(v => [v.id, markers.get(v.id)?.getLatLng()]).filter(x => x[1]).sort((a, b) => b[1].lat - a[1].lat).map(x => x[0]);
  if (!order.length) return liveStop();
  LIVE.idx = (LIVE.idx + 1) % order.length; liveLoad(order[LIVE.idx]);
  LIVE.timer = setTimeout(liveTick, 5000);
}
function updateLivePins() {
  const on = pinStyle.anim && pinStyle.thumb && map && $('#player').hidden && state.view === 'map';
  const sb = $('#sound-btn'); if (sb) sb.hidden = !(pinStyle.anim && pinStyle.thumb);
  if (!on) return liveStop();
  liveEnsure();
  if (LIVE.timer) return livePlace();
  LIVE.idx = Math.max(-1, LIVE.idx - 1); liveTick();
}
window.addEventListener('message', e => {
  if (!LIVE.frame || e.source !== LIVE.frame.contentWindow) return;
  let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.event === 'onReady') { LIVE.ready = true; if (LIVE.pending && LIVE.id === LIVE.pending) { LIVE.pending = null; liveLoad(LIVE.id); } }
  if (d.event === 'infoDelivery' && d.info) {
    if ('playerState' in d.info) { LIVE.state = d.info.playerState; if (LIVE.state === 0) { liveCmd('seekTo', [0, true]); liveCmd('playVideo'); } }
    if ('muted' in d.info) LIVE.muted = d.info.muted;
    if ('currentTime' in d.info) LIVE.time = d.info.currentTime;
  }
  window.__croytopiaLiveInfo = { id: LIVE.id, state: LIVE.state, ytMuted: LIVE.muted, soundSetting: pinSound, frames: document.querySelectorAll('.pth-live').length };
});
const SVG_SND = on => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${on ? '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : '<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'}</svg>`;
function updateSoundBtn() { const b = $('#sound-btn'); if (!b) return; b.innerHTML = SVG_SND(pinSound); b.classList.toggle('on', pinSound); b.setAttribute('aria-label', pinSound ? 'Pin sound on – mute' : 'Pin sound off – unmute'); b.setAttribute('aria-pressed', String(pinSound)); }
function addSoundControl() {
  const C = L.Control.extend({ options: { position: 'topright' }, onAdd() {
    const b = L.DomUtil.create('button', 'locate-btn sound-btn'); b.type = 'button'; b.id = 'sound-btn';
    L.DomEvent.disableClickPropagation(b);
    L.DomEvent.on(b, 'click', () => {
      pinSound = !pinSound; lsSet(SND_KEY, pinSound ? 'on' : 'off'); updateSoundBtn();
      if (pinSound) { liveCmd('unMute'); liveCmd('setVolume', [100]); if (LIVE.id) liveCmd('loadVideoById', [LIVE.id, LIVE.time || 0]); liveCmd('playVideo');   // inside the tap: a fresh unmuted load (unmuting a playing muted video gets paused by Chrome)
        const id = LIVE.id; clearTimeout(LIVE.fb); LIVE.fb = setTimeout(() => { if (LIVE.id === id && (LIVE.state !== 1 || LIVE.muted)) soundBlocked(); }, 1200); }
      else liveCmd('mute');
    });
    return b; } });
  map.addControl(new C()); updateSoundBtn();
}
function renderMarkers(vis) {
  layer.clearLayers();
  vis.forEach(v => {
    const m = markers.get(v.id); if (!m) return;
    m.setIcon(L.divIcon({ className: 'vpin-wrap', iconSize: [0, 0], iconAnchor: [0, 0], html: pinHTML(v) }));
    m.setZIndexOffset(selectedVideo === v.id ? 3000 : 0);
    layer.addLayer(m);
  });
  updateLivePins();
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
const PL = { id: null, state: -1, muted: false, ytMuted: null, frame: null, time: 0, timeAt: 0, dur: 0, autoplay: '', cc: lsGet(CC_KEY) !== 'off', raf: 0, fallbackT: 0 };
window.__croytopiaPlayer = PL;   // read-only status for automated tests
const SPK = {
  on: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  off: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>' };
const OVERSCAN = Math.max(0, +(new URLSearchParams(location.search).get('os') ?? 64) || 0);   // px pushed off-screen top+bottom (?os= for testing)
// The iframe is laid out "cover" with OVERSCAN px pushed off-screen top+bottom while YouTube's title/branding overlays
// are showing (~first 3-4 s of a load). Then PL.revealed scales it down (CSS transform, so the player doesn't see a
// resize) to plain cover = the full frame. PL.k renders the iframe k× bigger and scales it back (player-size hint for quality).
const QS = new URLSearchParams(location.search);
const HD_KEY = 'croytopia.hd';
// HD: the iframe is laid out 2× bigger and scaled back down, so YouTube's size-based picker streams 720p instead of 480p
// (measured: 854→1280 px tall). SD = real size (less data). ?k= overrides for testing.
PL.k = +(QS.get('k') || (lsGet(HD_KEY) === 'off' ? 1 : 2));
function updateHD() { const b = $('#pl-hd'); if (!b) return; const on = PL.k > 1; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
function sizeFrame() {
  const st = $('#pl-stage'), fr = PL.frame; if (!st || !fr) return;
  const v = CITY.byId[PL.id]; const a = v && v.width && v.height ? v.width / v.height : 9 / 16;
  const W = st.clientWidth, Hs = st.clientHeight, H = Hs + 2 * OVERSCAN;
  let w, h; if (W / H > a) { w = W; h = W / a; } else { h = H; w = H * a; }   // cover incl. overscan, never letterbox
  const s0 = Math.max(W / w, Hs / h);                                      // scale that removes the overscan (still cover)
  const k = PL.k, s = (PL.revealed ? s0 : 1) / k;
  Object.assign(fr.style, { width: Math.ceil(w * k) + 'px', height: Math.ceil(h * k) + 'px', left: Math.round((W - w * k) / 2) + 'px',
    top: Math.round((Hs - h * k) / 2) + 'px', transformOrigin: '50% 50%', transform: `scale(${s.toFixed(4)})`,
    transition: PL.revealed && !reduceMotion() ? 'transform .6s ease' : 'none' });
}
function scheduleReveal() {
  clearTimeout(PL.revealT);
  if (QS.get('reveal') === '0') return;
  PL.revealT = setTimeout(() => { if (PL.id && PL.state === 1) { PL.revealed = true; sizeFrame(); } }, 4000);
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
  $('#pl-frame').innerHTML = `<iframe id="pl-iframe" src="https://www.youtube-nocookie.com/embed/${first}?autoplay=0&controls=0&playsinline=1&rel=0&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0&modestbranding=1&enablejsapi=1${new URLSearchParams(location.search).get('vq') ? '&vq=' + encodeURIComponent(new URLSearchParams(location.search).get('vq')) : ''}&origin=${origin}" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" tabindex="-1"></iframe>`;
  PL.frame = $('#pl-iframe'); PL.ready = false;
  PL.frame.addEventListener('load', () => { PL.frame?.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'croytopia', channel: 'widget' }), '*'); });
}
// Expand the player out of the tapped pin (clip-path reveal + poster), and shrink back into it on close.
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function clipFor(r) {
  if (!r) return null; const W = innerWidth, H = innerHeight, rad = Math.min(r.width, r.height) / 2;
  return `inset(${Math.max(0, r.top)}px ${Math.max(0, W - r.right)}px ${Math.max(0, H - r.bottom)}px ${Math.max(0, r.left)}px round ${rad}px)`;
}
function animateClip(el, from, to, ms, done) {
  if (!from || reduceMotion() || !el.animate) { done?.(); return; }
  const a = el.animate([{ clipPath: from }, { clipPath: to }], { duration: ms, easing: 'cubic-bezier(.2,.8,.2,1)' });
  a.onfinish = () => done?.(); PL.anim = a;
}
// Neon ring that grows from the pin's circle out to the screen edges (open) or shrinks back into it (close).
function animateRing(r, open, ms) {
  let ring = $('#pl-ring'); if (!ring) { ring = document.createElement('div'); ring.id = 'pl-ring'; ring.setAttribute('aria-hidden', 'true'); document.body.appendChild(ring); }
  const pin = { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: Math.min(r.width, r.height) / 2 + 'px', opacity: 1 };
  const full = { left: '0px', top: '0px', width: innerWidth + 'px', height: innerHeight + 'px', borderRadius: '0px', opacity: 1 };
  ring.hidden = false;
  // same timing/easing as the clip-path so the ring stays exactly on the frame edge, then a short fade
  const E = 'cubic-bezier(.2,.8,.2,1)', o = ms / (ms + 160);
  const a = ring.animate(open ? [{ ...pin, easing: E }, { ...full, offset: o }, { ...full, opacity: 0 }] : [{ ...full, opacity: 0.4, easing: E }, { ...pin, offset: o }, { ...pin, opacity: 0 }],
    { duration: ms + 160, fill: 'forwards' });
  a.onfinish = () => { ring.hidden = true; a.cancel(); };
}
function openPlayer(id, originRect) {
  const v = CITY.byId[id]; if (!v) return;
  cancelAnimationFrame(PL.raf); clearTimeout(PL.fallbackT); clearTimeout(PL.revealT); PL.revealT = null; closeSearch();
  Object.assign(PL, { id, state: -1, time: 0, timeAt: 0, dur: v.duration || 0, autoplay: 'trying-unmuted', tapAt: performance.now(), userToggled: false, revealed: false });
  selectedVideo = id;
  ensurePlayerFrame();
  if (PL.ready) {
    // inside the user's tap: switch video and ask for sound
    clearTimeout(PL.revealT); PL.revealT = null; PL.revealed = false;
    ytCommand('loadVideoById', [id, 0]); PL.muted = false; ytCommand('unMute'); ytCommand('setVolume', [100]); ytCommand('playVideo');
  } else { PL.pendingId = id; PL.muted = false; }
  // If it isn't playing with sound quickly, the browser blocked it: start muted (always allowed), then try sound once more.
  PL.fallbackT = setTimeout(() => { if (PL.state !== 1) { PL.autoplay = 'muted-fallback'; setMuted(true); ytCommand('playVideo'); } }, 1500);
  const vis = visibleVideos(), i = vis.findIndex(x => x.id === id);
  $('#pl-info').innerHTML = `
    <button class="pl-info-close" aria-label="Close info">✕</button>
    <h2 id="pl-title">${esc(v.place)}</h2>${v.name ? `<p class="who">${esc(v.name)}</p>` : ''}
    <div class="label">Tags · auto-generated · tap to filter</div>${tagChips(v.tags)}
    ${v.description ? `<div class="label">Description (YouTube)</div><p class="desc">${esc(v.description)}</p>` : ''}
    ${v.transcript ? `<div class="label">Transcript · YouTube auto-captions</div><p class="tx-full">${highlight(v.transcript)}</p>` : ''}
    <p class="muted">${v.duration ? Math.round(v.duration) + 's · ' : ''}${esc(v.uploadDate || '')} · YouTube: ${esc(v.channel)}${v.legacy ? ' · from older map' : ''}</p>`;
  togglePlInfo(false);
  $('#pl-caption').innerHTML = ''; $('#pl-bar').style.width = '0';
  $('#pl-stage').classList.remove('pl-live');   // video stays invisible on a dark stage until it's actually playing
  const wasHidden = $('#player').hidden;
  $('#player').hidden = false; document.body.classList.add('playing');
  PL.origin = originRect || null;
  if (wasHidden && originRect && !reduceMotion()) { animateClip($('#player'), clipFor(originRect), 'inset(0px 0px 0px 0px round 0px)', 420); animateRing(originRect, true, 420); }
  updateMuteBtn(); updateCC(); updateHD(); sizeFrame(); PL.raf = requestAnimationFrame(tick);
  renderMarkers(vis);
}
function togglePlInfo(force) {
  const panel = $('#pl-info'), open = force ?? panel.hidden;
  panel.hidden = !open; $('#pl-info-btn').setAttribute('aria-expanded', String(open)); $('#pl-info-btn').classList.toggle('on', open);
  if (open) panel.scrollTop = 0;
}
function closePlayer() {
  if ($('#player').hidden) return;
  cancelAnimationFrame(PL.raf); clearTimeout(PL.fallbackT); clearTimeout(PL.revealT); PL.revealT = null;
  ytCommand('pauseVideo');
  const id = PL.id; PL.id = null; PL.state = -1;
  document.body.classList.remove('playing'); selectedVideo = null;
  const finish = () => { $('#player').hidden = true; $('#player').style.clipPath = ''; if (CITY) renderMarkers(visibleVideos()); };
  // target = the pin's current position if it's on screen (map view), else no animation
  const pinEl = id && state.view === 'map' && markers.get(id)?.getElement()?.querySelector('.pth,.pdot');
  const r = pinEl?.getBoundingClientRect();
  const onScreen = r && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  if (onScreen && !reduceMotion()) {
    $('#pl-stage').classList.remove('pl-live');           // video fades out first, then the frame contracts into the pin's ring
    setTimeout(() => { $('#player').style.clipPath = clipFor(r); animateClip($('#player'), 'inset(0px 0px 0px 0px round 0px)', clipFor(r), 380, finish); animateRing(r, false, 380); }, 160);
  } else finish();
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
      $('#pl-stage').classList.add('pl-live');
      if (!PL.revealed && !PL.revealT) scheduleReveal();
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
    if ('playbackQuality' in d.info) PL.quality = d.info.playbackQuality;
    if ('availableQualityLevels' in d.info) PL.levels = d.info.availableQualityLevels;
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
  let html = `<p class="note">Tap a bar to filter.</p>`;
  for (const [type, label] of Object.entries(groups)) {
    const e = Object.entries(counts).filter(([k]) => k.startsWith(type + '|')).map(([k, n]) => [k.split('|')[1], n]).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!e.length) continue;
    html += `<h3>${label}</h3>` + bars(e, e[0][1]);
  }
  const ce = Object.entries(contrib).sort((a, b) => b[1] - a[1]);
  html += `<h3>Contributors</h3>` + bars(ce, ce[0]?.[1] || 1, false);
  html += `<p class="note">Tags are <strong>auto-generated</strong> from YouTube titles and auto-captions using keyword rules (prototype). They can be wrong. Counts = number of videos${state.q || state.tags.size ? ' matching your current search/filters' : ''} (${vis.length}).</p>`;
  $('#view-patterns').innerHTML = html;
}
function renderActiveTags() {
  const qv = $('#q').value.trim();
  $('#search-btn .dot').hidden = !state.q;
  $('#active-tags').innerHTML = (state.q ? `<button class="chip on qchip" data-clearq="1" aria-label="Clear search ${esc(qv)}">🔍 ${esc(qv)} <span class="x">×</span></button>` : '') + [...state.tags].map(t => `<button class="chip on" data-tag="${esc(t)}" aria-label="Remove filter ${esc(t)}">${esc(t)} <span class="x">×</span></button>`).join('');
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
  $('#search-form').addEventListener('submit', e => { e.preventDefault(); clearTimeout(t); applySearch(true); closeSearch(); });
  $('#search-btn').addEventListener('click', () => { if ($('#search-pop').hidden) openSearch(); else closeSearch(); });
  $('#search-close').addEventListener('click', () => { clearTimeout(t); applySearch(false); closeSearch(); });
  $('#about-btn').addEventListener('click', openAbout);
  $('#about-close').addEventListener('click', closeAbout);
  $('#about-trailer').addEventListener('click', playTrailer);
  $$('.tab[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#pl-close').addEventListener('click', closePlayer);
  $('#pl-info-btn').addEventListener('click', () => togglePlInfo());
  $('#pl-mute').addEventListener('click', () => {
    const unmuting = PL.muted; setMuted(!PL.muted); if (PL.state !== 1) ytCommand('playVideo');
    // Strict autoplay policies pause a video that gets unmuted without a tap *inside* YouTube's frame: undo + keep playing
    if (unmuting) { const id = PL.id; setTimeout(() => { if (PL.id === id && PL.state !== 1) { setMuted(true); ytCommand('playVideo'); toast('Your browser blocked sound for this embed'); } }, 1500); }
  });
  $('#pl-hd').addEventListener('click', () => { PL.k = PL.k > 1 ? 1 : 2; lsSet(HD_KEY, PL.k > 1 ? 'on' : 'off'); updateHD(); sizeFrame(); });
  $('#pl-cc').addEventListener('click', () => { PL.cc = !PL.cc; lsSet(CC_KEY, PL.cc ? 'on' : 'off'); updateCC(); });
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
    cb.addEventListener('change', () => { pinStyle[cb.value] = cb.checked; savePinStyle(); renderMarkers(visibleVideos()); updateLivePins(); });
  });
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-tag]'); if (chip) { e.stopPropagation(); const bar = chip.classList.contains('bar'); if (bar) setView('map'); toggleTag(chip.dataset.tag); return; }
    if (e.target.closest('.pl-info-close')) return togglePlInfo(false);
    if (e.target.closest('[data-clearq]')) { $('#q').value = ''; state.q = ''; render(); fitToResults(false, true); return; }
    const card = e.target.closest('.card[data-vid]');
    if (card) { const v = CITY.byId[card.dataset.vid]; setView('map'); map.setView([v.lat, v.lng], Math.max(map.getZoom(), 16)); openPlayer(v.id, card.querySelector('.cthumb')?.getBoundingClientRect()); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (!$('#pl-info').hidden) return togglePlInfo(false); closePlayer(); closeAdd(); closeSearch(); closeAbout(); }
    if (e.key === 'Enter' && e.target.matches('.card')) e.target.click();
  });
  initAdd();
}

/* ---------- Mock "Upload your video" ---------- */
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
  INDEX = await loadJSON('data/cities.json');
  INDEX.cities.forEach(c => { if (c.data) c.data = c.data.replace(/\.enc\.json$/, '.json'); else c.data = `data/${c.slug}.json`; });   // tolerate an old index
  lsDel('croytopia.key.v1');   // old unlock key, no longer used
  document.querySelector('#gate')?.remove();   // a cached pre-2026-10-09 index.html may still contain the password gate
  navigator.serviceWorker?.getRegistrations?.().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
  enterApp();
})();
})();
