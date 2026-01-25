// script.js — Hiker Trail Tracker
// Foot map-matching via FOSSGIS + CORS-safe tiles

// ── OSRM map-matching endpoint (foot) ────────────────────
const OSRM_MATCH_BASE = 'https://routing.openstreetmap.de/routed-foot/match/v1/foot';
const OSRM_MATCH_LIMIT = 99;
const DENSIFY_STEP_METERS = 5;
const RADIUS_TRIES_METERS = [10, 14, 20, 28, 36];

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
let difficultyInput, notesInput, mappyInput, photosInput, mediaInput;
let deleteBtn, sortSelect, emptyState;

window.onload = () => {
  // ── Grab form elements ─────────────────────────────────
  form = document.getElementById('hike-form');
  nameInput = document.getElementById('hike-name');
  startInput = document.getElementById('hike-start-date');
  endInput = document.getElementById('hike-end-date');
  distInput = document.getElementById('hike-distance');
  difficultyInput = document.getElementById('hike-difficulty');
  notesInput = document.getElementById('hike-notes');
  mappyInput = document.getElementById('hike-mappy-link');
  photosInput = document.getElementById('hike-photos-link');
  mediaInput = document.getElementById('hike-media-link');
  deleteBtn = document.getElementById('delete-hike');
  sortSelect = document.getElementById('sort-select');
  emptyState = document.getElementById('empty-state');

  // ── Sidebar toggle (mobile) ────────────────────────────
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('toggle-sidebar');
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    setTimeout(() => map && map.invalidateSize(), 300);
  });

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

  const topo = L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    maxNativeZoom: 17,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    attribution: '&copy; OSM, SRTM | OpenTopoMap'
  }).addTo(map);

  const osmStd = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    maxNativeZoom: 19,
    detectRetina: false,
    errorTileUrl: transparent1x1,
    attribution: '&copy; OpenStreetMap contributors'
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
    { 'Topo': topo, 'OSM Standard': osmStd },
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

  // ── Load initial hikes.json ────────────────────────────
  fetch('hikes.json', { cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error('Could not load hikes.json');
      return res.json();
    })
    .then(data => {
      data.forEach(addExistingHike);
      renderHikeList();
      updateStats();
    })
    .catch(err => {
      console.log('No hikes.json found or empty:', err.message);
      updateStats();
    });

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
        notes,
        mappyLink: mappy,
        photosLink: photos,
        mediaLink: media
      });
      updateLayerTooltip(pendingLayer, distance);
    } else {
      // Create new hike
      const id = pendingLayer._leaflet_id;
      pendingLayer.setStyle({ color: '#2d6a4f', weight: 4, opacity: 0.8 });
      bindLayerTooltip(pendingLayer, distance);
      bindLayerClick(pendingLayer, id);

      hikes.push({
        id,
        name,
        distance,
        difficulty,
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
    const route = matched && matched.length ? matched : densify(raw, 2);

    drawnItems.removeLayer(layer);
    pendingLayer = L.polyline(route.map(c => [c[1], c[0]]), {
      color: '#2d6a4f',
      weight: 4,
      opacity: 0.8
    }).addTo(drawnItems);
    pendingLayer.routeCoords = route;

    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value = dist.toFixed(2);

    // Clear form
    nameInput.value = '';
    startInput.value = '';
    endInput.value = '';
    difficultyInput.value = '';
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

  // Fit map to hike
  if (hike.layer) {
    map.fitBounds(hike.layer.getBounds(), { padding: [50, 50] });
  }

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
  notesInput.value = hike.notes || '';
  mappyInput.value = hike.mappyLink || '';
  photosInput.value = hike.photosLink || '';
  mediaInput.value = hike.mediaLink || '';
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

      const latlngs = coords.map(c => [c[1], c[0]]);
      const layer = L.polyline(latlngs, {
        color: '#2d6a4f',
        weight: 4,
        opacity: 0.8
      }).addTo(drawnItems);

      pendingLayer = layer;
      pendingLayer.routeCoords = coords;

      // Fit map to imported route
      map.fitBounds(layer.getBounds(), { padding: [50, 50] });

      const dist = turf.length(turf.lineString(coords), { units: 'kilometers' });
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

// ── Add existing hike from data ──────────────────────────
function addExistingHike(h) {
  if (!h.route || !h.route.coordinates) {
    console.warn('Skipping hike with invalid route:', h);
    return;
  }

  // Create polyline from route coordinates
  const coords = h.route.coordinates;
  const latlngs = coords.map(c => [c[1], c[0]]);
  const layer = L.polyline(latlngs, {
    color: '#2d6a4f',
    weight: 4,
    opacity: 0.8
  }).addTo(drawnItems);

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
