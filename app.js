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
const KEY_STORE = 'croytopia.key.v1';
// Free OSM raster tiles (no key), darkened with a CSS filter. Prototype-level usage only (see OSM tile policy).
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
let map, layer, markers = new Map(), selectedPlace = null;
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
    v._hay = [v.title, v.place, v.contributor, v.description, v.transcript, v.tags.map(t => t.t).join(' ')].join(' \n ').toLowerCase();
  });
  document.title = `${CITY.city.brand} — prototype`;
  initMap(); bindUI(); render(); setView('map');
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

/* ---------- Map ---------- */
function initMap() {
  if (map) { map.remove(); markers.clear(); }
  map = L.map('map', { zoomControl: false, attributionControl: true, tap: true }).setView(CITY.city.center, CITY.city.zoom);
  addBaseLayers(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  CITY.places.forEach(p => {
    const m = L.marker([p.lat, p.lng], { keyboard: true, title: p.name, alt: p.name });
    m.on('click', () => openPlace(p.id));
    markers.set(p.id, m);
  });
  map.on('click', () => closeSheet());
  map.fitBounds(L.latLngBounds(CITY.places.map(p => [p.lat, p.lng])), { padding: [24, 24], maxZoom: 16 });
}
function renderMarkers(vis) {
  const counts = new Map();
  vis.forEach(v => counts.set(v.placeId, (counts.get(v.placeId) || 0) + 1));
  layer.clearLayers();
  CITY.places.forEach(p => {
    const n = counts.get(p.id); if (!n) return;
    const m = markers.get(p.id);
    m.setIcon(L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
      html: `<div class="pin ${n > 1 ? 'multi' : ''} ${selectedPlace === p.id ? 'sel' : ''}" aria-label="${esc(p.name)}: ${n} video${n > 1 ? 's' : ''}">${n > 1 ? n : '▶'}</div>` }));
    m.setZIndexOffset(selectedPlace === p.id ? 2000 : n > 1 ? 1000 : 0);
    layer.addLayer(m);
  });
}

/* ---------- Sheet ---------- */
function liteEmbed(v) {
  return `<button class="lite" data-yt="${v.id}" style="background-image:url(https://i.ytimg.com/vi/${v.id}/hqdefault.jpg)" aria-label="Play video: ${esc(v.title)}"><span class="play"></span></button>`;
}
function tagChips(tags, small) {
  return `<div class="chips">${tags.map(t => `<button class="chip ${state.tags.has(t.t) ? 'on' : ''}" data-tag="${esc(t.t)}" data-type="${t.type}">${esc(t.t)}</button>`).join('')}</div>`;
}
function openPlace(placeId, onlyVideo) {
  const p = CITY.places.find(x => x.id === placeId); if (!p) return;
  selectedPlace = placeId;
  const vids = p.videoIds.map(id => CITY.byId[id]).filter(v => !onlyVideo || v.id === onlyVideo).filter(Boolean);
  const people = [...new Set(vids.map(v => v.contributor))].join(', ');
  $('#sheet-body').innerHTML = `<h2 id="sheet-title">${esc(p.name)}</h2><p class="who">${vids.length} memor${vids.length > 1 ? 'ies' : 'y'} · ${esc(people)}</p>` +
    vids.map(v => `<article class="vid">
      ${liteEmbed(v)}
      <h3>${esc(v.title)}</h3>
      <p class="muted">${esc(v.contributor)} · ${v.duration ? Math.round(v.duration) + 's · ' : ''}${esc(v.uploadDate || '')} · YouTube: ${esc(v.channel)}${v.legacy ? ' · from older map' : ''}</p>
      ${v.description ? `<p class="desc">${esc(v.description)}</p>` : ''}
      ${v.summary ? `<p class="desc">${highlight(v.summary)}</p>` : ''}
      <div class="label">Tags · auto-generated</div>${tagChips(v.tags)}
      ${v.transcript ? `<details class="tx"><summary>Transcript (YouTube auto-captions)</summary><p>${highlight(v.transcript)}</p></details>` : `<p class="muted">No captions available.</p>`}
    </article>`).join('');
  $('#sheet').hidden = false; $('#sheet-body').scrollTop = 0;
  renderMarkers(visibleVideos());
}
function closeSheet() { $('#sheet').hidden = true; selectedPlace = null; if (CITY) renderMarkers(visibleVideos()); }

/* ---------- List & patterns ---------- */
function renderList(vis) {
  const ul = $('#list');
  if (!vis.length) { ul.innerHTML = `<li class="empty">No memories match. Try another word or clear the tags.</li>`; return; }
  ul.innerHTML = vis.map(v => {
    const sn = snippet(v);
    return `<li class="card" data-vid="${v.id}" tabindex="0" role="button" aria-label="${esc(v.title)}">
      <img loading="lazy" src="https://i.ytimg.com/vi/${v.id}/mqdefault.jpg" alt="" width="96" height="72">
      <div><h3>${esc(v.place)}</h3><p>${esc(v.contributor)}${v.legacy ? ' · older map' : ''}</p>
      ${sn ? `<p class="snip">“${sn}”</p>` : ''}
      ${tagChips(v.tags.slice(0, 4))}</div></li>`;
  }).join('');
}
function renderPatterns(vis) {
  const counts = {};
  vis.forEach(v => v.tags.forEach(t => { const k = t.type + '|' + t.t; counts[k] = (counts[k] || 0) + 1; }));
  const groups = { theme: 'Themes', era: 'Eras mentioned', place: 'Places & things mentioned', keyword: 'Frequent words' };
  const contrib = {}; vis.forEach(v => contrib[v.contributor] = (contrib[v.contributor] || 0) + 1);
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
  if (v !== 'map') closeSheet(); else setTimeout(() => map.invalidateSize(), 0);
}
function toggleTag(t) { state.tags.has(t) ? state.tags.delete(t) : state.tags.add(t); render(); if (selectedPlace && !$('#sheet').hidden) openPlace(selectedPlace); }

/* ---------- UI bindings ---------- */
let bound = false;
function bindUI() {
  if (bound) return; bound = true;
  let t; $('#q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { state.q = e.target.value.trim().toLowerCase(); render(); }, 80); });
  $$('.tab[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('click', e => {
    const chip = e.target.closest('[data-tag]'); if (chip) { e.stopPropagation(); toggleTag(chip.dataset.tag); if (chip.classList.contains('bar')) setView('map'); return; }
    const lite = e.target.closest('.lite[data-yt]');
    if (lite) {
      const box = document.createElement('div'); box.className = 'lite';
      box.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${lite.dataset.yt}?autoplay=1&playsinline=1&rel=0" title="${esc(lite.getAttribute('aria-label'))}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
      lite.replaceWith(box); return;
    }
    const card = e.target.closest('.card[data-vid]');
    if (card) { const v = CITY.byId[card.dataset.vid]; setView('map'); map.setView([v.lat, v.lng], Math.max(map.getZoom(), 16)); openPlace(v.placeId, v.id); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSheet(); closeAdd(); }
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
