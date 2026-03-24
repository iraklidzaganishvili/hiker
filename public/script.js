// script.js — Hiker Trail Tracker
// Foot map-matching via FOSSGIS + CORS-safe tiles

// ── Service Worker for tile caching ──────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ── OSRM map-matching endpoint (foot) ────────────────────
const OSRM_MATCH_BASE = 'https://routing.openstreetmap.de/routed-foot/match/v1/foot';
const OSRM_MATCH_LIMIT = 99;
const DENSIFY_STEP_METERS = 5;
const RADIUS_TRIES_METERS = [10, 14, 20, 28, 36];

// ── Auth State ─────────────────────────────────────────
let writeMode = false;
let authPassword = null;

// ── Utilities ────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function distKm(a, b) {
  return turf.distance(turf.point([a[0], a[1]]), turf.point([b[0], b[1]]), { units: 'kilometers' });
}

function densify(coords, stepMeters = DENSIFY_STEP_METERS) {
  if (coords.length < 2) return coords.slice();
  const out = [coords[0]];
  const stepKm = stepMeters / 1000;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const segKm = distKm(a, b);
    const n = Math.max(0, Math.floor(segKm / stepKm));
    for (let j = 1; j <= n; j++) {
      const t = j / (n + 1);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    out.push(b);
  }
  return out;
}

function concatCoords(base, next) {
  if (!base.length) return next.slice();
  if (!next.length) return base.slice();
  const a = base[base.length - 1], b = next[0];
  if (a[0] === b[0] && a[1] === b[1]) return base.concat(next.slice(1));
  return base.concat(next);
}

// ── Loading Overlay ──────────────────────────────────────
function showLoading() {
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ── API helpers ────────────────────────────────────────
async function apiGetHikes() {
  const res = await fetch('/api/hikes');
  if (!res.ok) throw new Error('Failed to load hikes');
  return res.json();
}

async function apiAuth(password) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'X-Password': password }
  });
  return res.ok;
}

async function apiSaveHikes() {
  if (!writeMode) return;
  const dataToSave = hikes.map(({ layer, ...rest }) => rest);
  const res = await fetch('/api/hikes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Password': authPassword
    },
    body: JSON.stringify(dataToSave)
  });
  if (!res.ok) {
    alert('Failed to save. You may need to refresh and re-authenticate.');
  }
}

// ── Route simplification ──────────────────────────────
function simplifyRoute(coords) {
  if (!coords || coords.length < 3) return coords;
  const line = turf.lineString(coords);
  const simplified = turf.simplify(line, { tolerance: 0.00005, highQuality: true });
  return simplified.geometry.coordinates;
}

// ── OSRM /match (foot) with chunking + radius ramp + timestamps ─
async function osrmMatchFoot(allCoords) {
  const coords = densify(allCoords, DENSIFY_STEP_METERS);
  let merged = [];
  const t0 = Math.floor(Date.now() / 1000);

  for (let start = 0; start < coords.length; start += (OSRM_MATCH_LIMIT - 1)) {
    const end = Math.min(coords.length, start + OSRM_MATCH_LIMIT);
    const chunk = coords.slice(start, end);

    let chunkGeom = null;
    const timestamps = chunk.map((_, i) => t0 + start + i).join(';');

    for (const R of RADIUS_TRIES_METERS) {
      const coordStr = chunk.map(c => `${c[0]},${c[1]}`).join(';');
      const radiuses = new Array(chunk.length).fill(R).join(';');

      const url = `${OSRM_MATCH_BASE}/${coordStr}` +
        `?overview=full&geometries=geojson&tidy=true&gaps=ignore` +
        `&radiuses=${radiuses}&timestamps=${timestamps}`;

      try {
        const res = await fetch(url, {
          mode: 'cors',
          cache: 'no-store',
          headers: { 'Accept': 'application/json' }
        });
        if (!res.ok) throw new Error('match not ok');
        const data = await res.json();
        if (data?.matchings?.length) {
          let geom = [];
          for (const m of data.matchings) {
            if (m?.geometry?.coordinates?.length) {
              geom = concatCoords(geom, m.geometry.coordinates);
            }
          }
          if (geom.length) {
            chunkGeom = geom;
            break;
          }
        }
      } catch (_) {
        // try next (wider) radius
      }
    }

    if (!chunkGeom) return null;

    merged = concatCoords(merged, chunkGeom);
    await sleep(50);
  }
  return merged.length ? merged : null;
}

// ── State ────────────────────────────────────────────────
let hikes = [];
let map, drawnItems, drawControl;
let pendingLayer = null, pendingEditHike = null;

// DOM Elements
let form, nameInput, startInput, endInput, distInput;
let difficultyInput, hikersInput, notesInput, mappyInput, photosInput, mediaInput;
let deleteBtn, sortSelect, emptyState;

window.onload = async () => {
  // ── Auth modal ───────────────────────────────────────
  const authModal = document.getElementById('auth-modal');
  const authInput = document.getElementById('auth-password');
  const authError = document.getElementById('auth-error');

  // Check for saved cookie first
  const savedPw = document.cookie.split('; ')
    .find(c => c.startsWith('hiker_auth='))
    ?.split('=')[1];

  let authResult = null;
  if (savedPw && await apiAuth(savedPw)) {
    authResult = savedPw;
  } else {
    // Cookie missing or invalid — show modal
    authModal.classList.remove('hidden');
    authResult = await new Promise(resolve => {
      document.getElementById('auth-submit').addEventListener('click', async () => {
        const pw = authInput.value;
        if (!pw) return;
        const ok = await apiAuth(pw);
        if (ok) {
          resolve(pw);
        } else {
          authError.classList.remove('hidden');
          authInput.value = '';
          authInput.focus();
        }
      });

      authInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('auth-submit').click();
      });

      document.getElementById('auth-cancel').addEventListener('click', () => {
        resolve(null);
      });
    });
  }

  authModal.classList.add('hidden');

  if (authResult) {
    writeMode = true;
    authPassword = authResult;
    document.cookie = 'hiker_auth=' + authResult + '; max-age=31536000; path=/';
  }

  // ── Grab form elements ─────────────────────────────────
  form = document.getElementById('hike-form');
  nameInput = document.getElementById('hike-name');
  startInput = document.getElementById('hike-start-date');
  endInput = document.getElementById('hike-end-date');
  distInput = document.getElementById('hike-distance');
  difficultyInput = document.getElementById('hike-difficulty');
  hikersInput = document.getElementById('hike-hikers');
  notesInput = document.getElementById('hike-notes');
  mappyInput = document.getElementById('hike-mappy-link');
  photosInput = document.getElementById('hike-photos-link');
  mediaInput = document.getElementById('hike-media-link');
  deleteBtn = document.getElementById('delete-hike');
  sortSelect = document.getElementById('sort-select');
  emptyState = document.getElementById('empty-state');

  // ── Tab switching ────────────────────────────────────
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ── Mobile bottom sheet ──────────────────────────────
  initBottomSheet();

  // ── File inputs ────────────────────────────────────────
  const jsonFileInput = document.getElementById('json-file-input');
  const gpxFileInput = document.getElementById('gpx-file-input');

  document.getElementById('load-json').addEventListener('click', () => jsonFileInput.click());
  document.getElementById('import-gpx').addEventListener('click', () => gpxFileInput.click());

  jsonFileInput.addEventListener('change', handleUpload);
  gpxFileInput.addEventListener('change', handleGpxFile);

  // ── Sorting ────────────────────────────────────────────
  sortSelect.addEventListener('change', renderHikeList);

  // ── Delete button ──────────────────────────────────────
  deleteBtn.addEventListener('click', deleteCurrentHike);

  // ── Initialize Leaflet map ─────────────────────────────
  map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([41.7151, 44.8271], 13);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const transparent1x1 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

  const osmStd = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    maxNativeZoom: 19,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const topo = L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    maxNativeZoom: 17,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    attribution: '&copy; OSM, SRTM | OpenTopoMap'
  });

  const voyager = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    detectRetina: true,
    errorTileUrl: transparent1x1,
    attribution: '&copy; OSM &copy; CARTO'
  });

  const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    attribution: '&copy; Esri, Maxar, Earthstar'
  });

  const trails = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 17,
    maxNativeZoom: 17,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    opacity: 0.95,
    attribution: '&copy; Waymarked Trails'
  });

  L.control.layers(
    { 'OSM': osmStd, 'Voyager': voyager, 'Topo': topo, 'Satellite': satellite },
    { 'Trails': trails },
    { position: 'bottomright' }
  ).addTo(map);

  // ── Drawing toolbar ────────────────────────────────────
  drawnItems = new L.FeatureGroup().addTo(map);
  drawControl = new L.Control.Draw({
    position: 'topright',
    draw: {
      polyline: {
        shapeOptions: {
          color: '#2d6a4f',
          weight: 4,
          opacity: 0.8
        }
      },
      polygon: false,
      rectangle: false,
      circle: false,
      circlemarker: false,
      marker: false
    },
    edit: false
  });
  map.addControl(drawControl);

  // ── Mode-dependent UI ──────────────────────────────────
  if (writeMode) {
    document.getElementById('load-json').classList.add('hidden');
    document.getElementById('download-json').classList.add('hidden');
  } else {
    document.querySelector('.leaflet-draw').classList.add('hidden');
    document.getElementById('import-gpx').classList.add('hidden');
  }

  // ── Viewport-based route rendering & tooltip visibility ─
  map.on('moveend', () => {
    updateVisibleRoutes();
    updateTooltipVisibility();
  });

  // ── Load hikes from API ──────────────────────────────
  try {
    const data = await apiGetHikes();
    data.forEach(addExistingHike);
    renderHikeList();
    updateStats();
  } catch (err) {
    console.log('Failed to load hikes:', err.message);
    updateStats();
  }

  // Initial viewport cull + tooltip check after hikes are loaded
  updateVisibleRoutes();
  updateTooltipVisibility();

  // ── Download JSON ──────────────────────────────────────
  document.getElementById('download-json').addEventListener('click', () => {
    const dataToSave = hikes.map(({ layer, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(dataToSave, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hikes.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── Cancel form ────────────────────────────────────────
  document.getElementById('cancel-hike').addEventListener('click', () => {
    if (pendingLayer && !pendingEditHike) {
      drawnItems.removeLayer(pendingLayer);
    }
    clearActiveHikeSelection();
    pendingLayer = pendingEditHike = null;
    form.classList.add('hidden');
    deleteBtn.classList.add('hidden');
  });

  // ── Save hike ──────────────────────────────────────────
  document.getElementById('save-hike').addEventListener('click', async () => {
    if (!pendingLayer) return;

    const name = nameInput.value.trim() || 'Unnamed Hike';
    const start = startInput.value || null;
    const end = endInput.value || null;
    const distance = parseFloat(distInput.value) || 0;
    const difficulty = parseInt(difficultyInput.value) || null;
    const hikers = hikersInput.value.trim()
      ? hikersInput.value.split(',').map(s => s.trim()).filter(Boolean).map(s => s.charAt(0).toUpperCase() + s.slice(1))
      : [];
    const notes = notesInput.value.trim() || null;
    const mappy = mappyInput.value.trim() || null;
    const photos = photosInput.value.trim() || null;
    const media = mediaInput.value.trim() || null;

    if (pendingEditHike) {
      // Update existing hike
      Object.assign(pendingEditHike, {
        name,
        startDate: start,
        endDate: end,
        distance,
        difficulty,
        hikers,
        notes,
        mappyLink: mappy,
        photosLink: photos,
        mediaLink: media
      });
      updateLayerTooltip(pendingLayer, distance);
    } else {
      // Create new hike
      const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
      pendingLayer.setStyle({ color: '#2d6a4f', weight: 4, opacity: 0.8 });
      bindLayerTooltip(pendingLayer, distance);
      bindLayerClick(pendingLayer, id);

      hikes.push({
        id,
        name,
        distance,
        difficulty,
        hikers,
        notes,
        route: { type: 'LineString', coordinates: pendingLayer.routeCoords },
        startDate: start,
        endDate: end,
        mappyLink: mappy,
        photosLink: photos,
        mediaLink: media,
        layer: pendingLayer
      });
    }

    clearActiveHikeSelection();
    pendingLayer = pendingEditHike = null;
    form.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    renderHikeList();
    updateStats();
    await apiSaveHikes();
  });

  // ── Drawing created event ──────────────────────────────
  map.on('draw:created', async e => {
    const layer = e.layer;
    drawnItems.addLayer(layer);

    const raw = layer.toGeoJSON().geometry.coordinates;

    showLoading();
    let matched;
    try {
      matched = await osrmMatchFoot(raw);
    } catch (err) {
      console.error('Route matching error:', err);
    }
    hideLoading();

    // Fallback: keep user's sketch if matching fails
    const rawRoute = matched && matched.length ? matched : densify(raw, 2);
    const route = simplifyRoute(rawRoute) || rawRoute;

    drawnItems.removeLayer(layer);
    pendingLayer = L.polyline(route.map(c => [c[1], c[0]]), {
      color: '#2d6a4f',
      weight: 4,
      opacity: 0.8
    }).addTo(drawnItems);
    pendingLayer._onMap = true;
    pendingLayer.routeCoords = route;

    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value = dist.toFixed(2);

    // Clear form
    nameInput.value = '';
    startInput.value = '';
    endInput.value = '';
    difficultyInput.value = '';
    hikersInput.value = '';
    notesInput.value = '';
    mappyInput.value = '';
    photosInput.value = '';
    mediaInput.value = '';

    form.classList.remove('hidden');
    deleteBtn.classList.add('hidden');
  });
};

// ── Tooltip helpers ──────────────────────────────────────
function bindLayerTooltip(layer, distance) {
  layer.bindTooltip(`${distance.toFixed(2)} km`, {
    permanent: true,
    direction: 'center',
    className: 'distance-tooltip'
  }).openTooltip();
}

// ── Layer click handler ──────────────────────────────────
function bindLayerClick(layer, hikeId) {
  layer.on('click', () => {
    const hike = hikes.find(h => h.id === hikeId);
    if (!hike) return;
    selectHike(hike);
  });

  // Visual feedback on hover
  layer.on('mouseover', () => {
    layer.setStyle({ weight: 6, opacity: 1 });
  });
  layer.on('mouseout', () => {
    layer.setStyle({ weight: 4, opacity: 0.8 });
  });
}

// ── Select a hike (used by list click and map click) ─────
function selectHike(hike) {
  clearActiveHikeSelection();

  // Highlight in list
  const listItem = document.querySelector(`#hike-list li[data-id="${hike.id}"]`);
  if (listItem) {
    listItem.classList.add('active');
    listItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Ensure layer is on the map before fitting bounds
  if (hike.layer) {
    if (!hike.layer._onMap) {
      drawnItems.addLayer(hike.layer);
      hike.layer._onMap = true;
    }
    map.fitBounds(hike.layer.getBounds(), { padding: [50, 50] });
  }

  if (writeMode) {
    // Set up editing
    pendingEditHike = hike;
    pendingLayer = hike.layer;

    // Show form
    form.classList.remove('hidden');
    deleteBtn.classList.remove('hidden');

    // Populate form
    nameInput.value = hike.name;
    startInput.value = hike.startDate || '';
    endInput.value = hike.endDate || '';
    distInput.value = hike.distance.toFixed(2);
    difficultyInput.value = hike.difficulty || '';
    hikersInput.value = (hike.hikers || []).join(', ');
    notesInput.value = hike.notes || '';
    mappyInput.value = hike.mappyLink || '';
    photosInput.value = hike.photosLink || '';
    mediaInput.value = hike.mediaLink || '';
  }
}

function updateLayerTooltip(layer, distance) {
  if (layer.getTooltip()) {
    layer.setTooltipContent(`${distance.toFixed(2)} km`);
  } else {
    bindLayerTooltip(layer, distance);
  }
}

// ── Stats update ─────────────────────────────────────────
function updateStats() {
  const totalHikes = hikes.length;
  const totalDistance = hikes.reduce((sum, h) => sum + (h.distance || 0), 0);

  document.getElementById('total-hikes').textContent = totalHikes;
  document.getElementById('total-distance').textContent = totalDistance.toFixed(1);

  // Show/hide empty state
  if (totalHikes === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
  }

  renderLeaderboard();
}

// ── Leaderboard ─────────────────────────────────────────
function renderLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const empty = document.getElementById('leaderboard-empty');
  if (!list) return;

  // Aggregate by hiker name
  const stats = {};
  hikes.forEach(h => {
    const hikerList = h.hikers || [];
    hikerList.forEach(raw => {
      // Support multiplier: "Irakli-3" counts as 3 hikes
      const match = raw.match(/^(.+?)-(\d+)$/);
      const baseName = match ? match[1] : raw;
      const count = match ? parseInt(match[2]) : 1;
      const name = baseName.charAt(0).toUpperCase() + baseName.slice(1);
      if (!stats[name]) stats[name] = { hikes: 0, points: 0, distance: 0 };
      stats[name].hikes += count;
      stats[name].distance += (h.distance || 0) * count;
      stats[name].points += (h.distance || 0) * (h.difficulty || 0) * count;
    });
  });

  const sorted = Object.entries(stats)
    .map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.points - a.points);

  list.innerHTML = '';

  if (sorted.length === 0) {
    if (empty) empty.classList.remove('hidden');
    return;
  }
  if (empty) empty.classList.add('hidden');

  sorted.forEach((hiker, i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="lb-rank">${i + 1}</div>
      <div class="lb-info">
        <div class="lb-name">${escapeHtml(hiker.name)}</div>
        <div class="lb-stats">
          <span><i class="fas fa-hiking"></i>${hiker.hikes}</span>
          <span><i class="fas fa-ruler"></i>${hiker.distance.toFixed(1)} km</span>
        </div>
      </div>
      <div class="lb-points">${Math.round(hiker.points)} pts</div>
    `;
    list.appendChild(li);
  });
}

// ── Render hike list ─────────────────────────────────────
function renderHikeList() {
  const list = document.getElementById('hike-list');
  list.innerHTML = '';

  const sorted = [...hikes];
  const mode = sortSelect.value;

  sorted.sort((a, b) => {
    switch (mode) {
      case 'dateDesc': {
        const da = a.startDate ? new Date(a.startDate) : new Date(0);
        const db = b.startDate ? new Date(b.startDate) : new Date(0);
        return db - da;
      }
      case 'dateAsc': {
        const da = a.startDate ? new Date(a.startDate) : new Date(0);
        const db = b.startDate ? new Date(b.startDate) : new Date(0);
        return da - db;
      }
      case 'distanceDesc':
        return b.distance - a.distance;
      case 'distanceAsc':
        return a.distance - b.distance;
      case 'difficultyDesc':
        return (b.difficulty || 0) - (a.difficulty || 0);
      case 'difficultyAsc':
        return (a.difficulty || 0) - (b.difficulty || 0);
      case 'nameAsc':
        return a.name.localeCompare(b.name);
      case 'nameDesc':
        return b.name.localeCompare(a.name);
      default:
        return 0;
    }
  });

  sorted.forEach(hike => {
    const li = document.createElement('li');
    li.dataset.id = hike.id;
    li.innerHTML = buildHikeCardHTML(hike);
    li.onclick = () => selectHike(hike);
    list.appendChild(li);
  });

  // Update empty state visibility
  if (hikes.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
  }
}

function clearActiveHikeSelection() {
  document.querySelectorAll('#hike-list li.active').forEach(li => {
    li.classList.remove('active');
  });
}

function buildHikeCardHTML(hike) {
  let difficultyBadge = '';
  if (hike.difficulty != null && hike.difficulty !== '') {
    const level = hike.difficulty;
    let diffClass = 'difficulty-easy';
    let diffLabel = 'Easy';
    if (level >= 7) {
      diffClass = 'difficulty-hard';
      diffLabel = 'Hard';
    } else if (level >= 4) {
      diffClass = 'difficulty-medium';
      diffLabel = 'Moderate';
    }
    difficultyBadge = `<span class="difficulty-badge ${diffClass}">${diffLabel} (${level}/10)</span>`;
  }

  let dateStr = '';
  if (hike.startDate && hike.endDate && hike.startDate !== hike.endDate) {
    dateStr = `${formatDate(hike.startDate)} - ${formatDate(hike.endDate)}`;
  } else if (hike.startDate) {
    dateStr = formatDate(hike.startDate);
  }

  return `
    <div class="hike-card-name">
      <i class="fas fa-route"></i>
      ${escapeHtml(hike.name)}
    </div>
    <div class="hike-card-meta">
      <span><i class="fas fa-ruler"></i> ${hike.distance.toFixed(2)} km</span>
      ${dateStr ? `<span><i class="fas fa-calendar"></i> ${dateStr}</span>` : ''}
      ${difficultyBadge}
      ${hike.hikers && hike.hikers.length ? `<span><i class="fas fa-users"></i> ${hike.hikers.map(escapeHtml).join(', ')}</span>` : ''}
    </div>
  `;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Delete hike ──────────────────────────────────────────
function deleteCurrentHike() {
  if (!pendingEditHike || !pendingLayer) return;

  if (!confirm(`Delete "${pendingEditHike.name}"?`)) return;

  drawnItems.removeLayer(pendingLayer);
  hikes = hikes.filter(h => h.id !== pendingEditHike.id);

  clearActiveHikeSelection();
  pendingEditHike = pendingLayer = null;
  form.classList.add('hidden');
  deleteBtn.classList.add('hidden');

  renderHikeList();
  updateStats();
  apiSaveHikes();
}

// ── Handle JSON upload ───────────────────────────────────
function handleUpload(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const data = JSON.parse(evt.target.result);
      hikes = [];
      drawnItems.clearLayers();
      document.getElementById('hike-list').innerHTML = '';
      data.forEach(addExistingHike);
      renderHikeList();
      updateStats();
      updateVisibleRoutes();
      updateTooltipVisibility();
    } catch (err) {
      console.error('Invalid JSON', err);
      alert('Failed to load JSON file. Please check the file format.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── GPX handling ─────────────────────────────────────────
function parseGPXToLngLat(gpxText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(gpxText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid GPX');

  const trkpts = Array.from(xml.getElementsByTagName('trkpt'));
  if (trkpts.length) {
    return trkpts
      .map(pt => [parseFloat(pt.getAttribute('lon')), parseFloat(pt.getAttribute('lat'))])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  }

  const rtepts = Array.from(xml.getElementsByTagName('rtept'));
  if (rtepts.length) {
    return rtepts
      .map(pt => [parseFloat(pt.getAttribute('lon')), parseFloat(pt.getAttribute('lat'))])
      .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  }

  return [];
}

function handleGpxFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      const coords = parseGPXToLngLat(evt.target.result);
      if (!coords.length) {
        alert('No track/route points found in GPX file.');
        e.target.value = '';
        return;
      }

      const simplifiedCoords = simplifyRoute(coords) || coords;
      const latlngs = simplifiedCoords.map(c => [c[1], c[0]]);
      const layer = L.polyline(latlngs, {
        color: '#2d6a4f',
        weight: 4,
        opacity: 0.8
      }).addTo(drawnItems);
      layer._onMap = true;

      pendingLayer = layer;
      pendingLayer.routeCoords = simplifiedCoords;

      // Fit map to imported route
      map.fitBounds(layer.getBounds(), { padding: [50, 50] });

      const dist = turf.length(turf.lineString(simplifiedCoords), { units: 'kilometers' });
      distInput.value = dist.toFixed(2);

      nameInput.value = file.name.replace(/\.gpx$/i, '');
      startInput.value = '';
      endInput.value = '';
      difficultyInput.value = '';
      notesInput.value = '';
      mappyInput.value = '';
      photosInput.value = '';
      mediaInput.value = '';

      form.classList.remove('hidden');
      deleteBtn.classList.add('hidden');
    } catch (err) {
      console.error(err);
      alert('Failed to read GPX file.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
}

// ── Viewport-based route rendering ───────────────────────
function updateVisibleRoutes() {
  if (!map || !drawnItems) return;
  const mapBounds = map.getBounds();
  hikes.forEach(hike => {
    if (!hike.layer) return;
    const layerBounds = hike.layer.getBounds();
    const shouldShow = mapBounds.intersects(layerBounds);
    if (shouldShow && !hike.layer._onMap) {
      drawnItems.addLayer(hike.layer);
      hike.layer._onMap = true;
    } else if (!shouldShow && hike.layer._onMap) {
      drawnItems.removeLayer(hike.layer);
      hike.layer._onMap = false;
    }
  });
}

// ── Zoom-based tooltip visibility ────────────────────────
function updateTooltipVisibility() {
  if (!map) return;
  const zoom = map.getZoom();
  const show = zoom >= 11;
  hikes.forEach(hike => {
    if (!hike.layer) return;
    if (show && hike.layer._onMap) {
      hike.layer.openTooltip();
    } else {
      hike.layer.closeTooltip();
    }
  });
}

// ── Add existing hike from data ──────────────────────────
function addExistingHike(h) {
  if (!h.route || !h.route.coordinates) {
    console.warn('Skipping hike with invalid route:', h);
    return;
  }

  // Create polyline from route coordinates (don't add to map yet — viewport culling handles it)
  const coords = h.route.coordinates;
  const latlngs = coords.map(c => [c[1], c[0]]);
  const layer = L.polyline(latlngs, {
    color: '#2d6a4f',
    weight: 4,
    opacity: 0.8
  });
  layer._onMap = false;

  // Store route coords for editing
  layer.routeCoords = coords;

  const id = (h && 'id' in h && h.id != null) ? h.id : layer._leaflet_id;
  layer._leaflet_id = id;

  let distance = typeof h.distance === 'number' ? h.distance : 0;
  if (!distance) {
    try {
      distance = turf.length(turf.lineString(coords), { units: 'kilometers' });
    } catch {
      distance = 0;
    }
  }
  distance = Number.isFinite(distance) ? distance : 0;

  bindLayerTooltip(layer, distance);
  bindLayerClick(layer, id);

  hikes.push({
    id,
    name: h.name || 'Unnamed Hike',
    distance,
    difficulty: h.difficulty ?? null,
    hikers: h.hikers || [],
    notes: h.notes || null,
    route: h.route,
    startDate: h.startDate || null,
    endDate: h.endDate || null,
    mappyLink: h.mappyLink || null,
    photosLink: h.photosLink || null,
    mediaLink: h.mediaLink || null,
    layer
  });
}

// ── Sidebar resize drag (desktop only) ───────────────────
(function() {
  const handle = document.getElementById('sidebar-resize');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    // Only activate on desktop
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newWidth = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (typeof map !== 'undefined') map.invalidateSize();
  });
})();

// ── Mobile bottom sheet ──────────────────────────────────
function initBottomSheet() {
  const sidebar = document.getElementById('sidebar');
  const dragHandle = document.getElementById('drag-handle');
  if (!sidebar || !dragHandle) return;

  // States and their max-height thresholds (as fraction of vh)
  const STATES = ['collapsed', 'half', 'full'];
  let currentState = 'half';

  function isMobile() {
    return window.innerWidth <= 768;
  }

  function applyState(state) {
    STATES.forEach(s => sidebar.classList.remove(s));
    sidebar.classList.add(state);
    currentState = state;
    // After transition, invalidate map size
    setTimeout(() => {
      if (typeof map !== 'undefined' && map) map.invalidateSize();
    }, 350);
  }

  // Set initial state on mobile
  function checkMobile() {
    if (isMobile()) {
      if (!STATES.some(s => sidebar.classList.contains(s))) {
        applyState('half');
      }
    } else {
      // Remove all bottom sheet states on desktop
      STATES.forEach(s => sidebar.classList.remove(s));
      sidebar.style.width = '';
    }
  }

  checkMobile();
  window.addEventListener('resize', checkMobile);

  // Touch drag handling
  let startY = 0;
  let startMaxHeight = 0;
  let isDragging = false;

  function getMaxHeightPx() {
    return sidebar.getBoundingClientRect().height;
  }

  dragHandle.addEventListener('touchstart', (e) => {
    if (!isMobile()) return;
    isDragging = true;
    startY = e.touches[0].clientY;
    startMaxHeight = getMaxHeightPx();
    sidebar.style.transition = 'none';
  }, { passive: true });

  dragHandle.addEventListener('touchmove', (e) => {
    if (!isDragging || !isMobile()) return;
    const currentY = e.touches[0].clientY;
    const deltaY = startY - currentY; // positive = dragging up
    const newHeight = Math.max(100, Math.min(window.innerHeight * 0.9, startMaxHeight + deltaY));
    sidebar.style.maxHeight = newHeight + 'px';
  }, { passive: true });

  dragHandle.addEventListener('touchend', () => {
    if (!isDragging || !isMobile()) return;
    isDragging = false;
    sidebar.style.transition = '';

    // Snap to nearest state based on current height
    const height = sidebar.getBoundingClientRect().height;
    const vh = window.innerHeight;
    const ratio = height / vh;

    // Thresholds: collapsed < 0.25, half 0.25-0.65, full > 0.65
    let newState;
    if (ratio < 0.25) {
      newState = 'collapsed';
    } else if (ratio < 0.65) {
      newState = 'half';
    } else {
      newState = 'full';
    }

    // Remove inline max-height so CSS class takes over
    sidebar.style.maxHeight = '';
    applyState(newState);
  }, { passive: true });

  // Also allow clicking the drag handle to cycle states
  dragHandle.addEventListener('click', () => {
    if (!isMobile()) return;
    const idx = STATES.indexOf(currentState);
    const nextIdx = (idx + 1) % STATES.length;
    applyState(STATES[nextIdx]);
  });
}
