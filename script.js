// script.js — footpath-first snapping using ONLY OSRM /match (foot) + graceful fallback

// ── OSRM map-matching endpoint ───────────────────────────
const OSRM_MATCH_BASE = 'https://router.project-osrm.org/match/v1/foot';
const OSRM_MATCH_LIMIT = 99;        // keep chunks under ~100 points
const DENSIFY_STEP_METERS = 8;      // tighter spacing → better trail hugging
const RADIUS_TRIES_METERS = [18, 25, 35]; // prefer nearby paths; widen only if needed

// ── Utilities ────────────────────────────────────────────
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function distKm(a, b) {
  return turf.distance(turf.point([a[0], a[1]]), turf.point([b[0], b[1]]), { units: 'kilometers' });
}

// densify an array of [lng,lat] points with fixed step
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

// ── OSRM map-matching (foot) with chunking & radius ramp ─
async function osrmMatchFoot(allCoords) {
  const coords = densify(allCoords, DENSIFY_STEP_METERS);
  let merged = [];

  for (let start = 0; start < coords.length; start += (OSRM_MATCH_LIMIT - 1)) {
    const end = Math.min(coords.length, start + OSRM_MATCH_LIMIT);
    const chunk = coords.slice(start, end);

    let chunkGeom = null;

    // try tighter → wider radiuses; tighter favors nearby paths over roads
    for (const R of RADIUS_TRIES_METERS) {
      const coordStr = chunk.map(c => `${c[0]},${c[1]}`).join(';');
      const radiuses = new Array(chunk.length).fill(R).join(';');

      const url = `${OSRM_MATCH_BASE}/${coordStr}` +
                  `?overview=full&geometries=geojson&tidy=true&gaps=ignore&radiuses=${radiuses}`;

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
            break; // got it with this radius
          }
        }
      } catch (_) {
        // try with next (wider) radius
      }
    }

    if (!chunkGeom) {
      // if any chunk fails to match, bail out so caller can fallback to the sketch
      return null;
    }

    merged = concatCoords(merged, chunkGeom);
    // be kind to public server
    await sleep(50);
  }

  return merged.length ? merged : null;
}

// ── State ────────────────────────────────────────────────
let hikes = [];
let map, drawnItems, drawControl;
let pendingLayer = null, pendingEditHike = null;

// form fields + controls
let form, nameInput, startInput, endInput, distInput;
let difficultyInput, mappyInput, photosInput, mediaInput;
let deleteBtn, sortSelect;

window.onload = () => {
  // ── Grab form & basic inputs ────────────────────────────
  form       = document.getElementById('hike-form');
  nameInput  = document.getElementById('hike-name');
  startInput = document.getElementById('hike-start-date');
  endInput   = document.getElementById('hike-end-date');
  distInput  = document.getElementById('hike-distance');

  // ── Dynamically add difficulty numeric field ────────────
  difficultyInput = createFormField('Difficulty (1-10):', 'hike-difficulty', 'number');
  difficultyInput.min = 1; difficultyInput.max = 10; difficultyInput.step = 1;

  // ── Dynamically add the 3 optional link fields ─────────
  mappyInput  = createFormField('Mappy Link (optional):', 'hike-mappy-link', 'url');
  photosInput = createFormField('Photos Link (optional):', 'hike-photos-link', 'url');
  mediaInput  = createFormField('Media Link (optional):', 'hike-media-link', 'url');

  form.classList.add('hidden');

  // ── Sidebar toggle (mobile) ─────────────────────────────
  const sidebar  = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('toggle-sidebar');
  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('hidden');
    setTimeout(() => map && map.invalidateSize(), 200);
  });

  // ── Hidden file-input & "Load JSON" button ─────────────
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', handleUpload);
  sidebar.appendChild(fileInput);

  const loadBtn = document.createElement('button');
  loadBtn.id = 'load-json';
  loadBtn.textContent = 'Load JSON';
  loadBtn.style.width = '100%';
  loadBtn.style.padding = '8px';
  loadBtn.style.marginBottom = '10px';
  sidebar.insertBefore(loadBtn, document.getElementById('download-json'));
  loadBtn.addEventListener('click', () => fileInput.click());

  // ── "Add Hikes" (manual coords) ────────────────────────
  const addCoordsBtn = document.createElement('button');
  addCoordsBtn.id = 'add-hikes';
  addCoordsBtn.textContent = 'Add Hikes';
  addCoordsBtn.style.width = '100%';
  addCoordsBtn.style.padding = '8px';
  addCoordsBtn.style.marginBottom = '10px';
  sidebar.insertBefore(addCoordsBtn, loadBtn.nextSibling);
  addCoordsBtn.addEventListener('click', () => {
    const input = prompt('Enter coordinates eg. [[44.8271,41.7151],[44.8285,41.7160],[44.8300,41.7200],[44.8320,41.7220]]:');
    if (!input) return;
    let coords;
    try {
      coords = JSON.parse(input);
      if (!Array.isArray(coords) || coords.length < 2) throw new Error();
    } catch {
      alert('Invalid format. Please enter a JSON array like [[lng,lat],[lng,lat],...]');
      return;
    }
    const route = coords;
    const latlngs = route.map(c => [c[1], c[0]]);
    const layer = L.polyline(latlngs).addTo(drawnItems);
    pendingLayer = layer;
    pendingLayer.routeCoords = route;

    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value = dist.toFixed(2);
    nameInput.value = startInput.value = endInput.value = '';
    difficultyInput.value = mappyInput.value = photosInput.value = mediaInput.value = '';
    form.classList.remove('hidden');
    deleteBtn.classList.add('hidden');
  });

  // ── Sorting dropdown ───────────────────────────────────
  sortSelect = document.createElement('select');
  sortSelect.id = 'sort-select';
  sortSelect.style.width = '100%';
  sortSelect.style.padding = '8px';
  sortSelect.style.marginBottom = '10px';
  [
    { value: 'dateDesc',      text: 'Date (Newest First)' },
    { value: 'dateAsc',       text: 'Date (Oldest First)' },
    { value: 'distanceDesc',  text: 'Distance (Longest First)' },
    { value: 'distanceAsc',   text: 'Distance (Shortest First)' },
    { value: 'difficultyDesc',text: 'Difficulty (Hardest First)' },
    { value: 'difficultyAsc', text: 'Difficulty (Easiest First)' },
    { value: 'nameAsc',       text: 'Name (A–Z)' },
    { value: 'nameDesc',      text: 'Name (Z–A)' }
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value; o.textContent = opt.text;
    sortSelect.appendChild(o);
  });
  sortSelect.addEventListener('change', renderHikeList);
  sidebar.insertBefore(sortSelect, loadBtn);

  // ── Delete button (shown when editing) ─────────────────
  deleteBtn = document.createElement('button');
  deleteBtn.id = 'delete-hike';
  deleteBtn.textContent = 'Delete';
  deleteBtn.style.marginRight = '5px';
  deleteBtn.classList.add('hidden');
  document.getElementById('cancel-hike').insertAdjacentElement('afterend', deleteBtn);
  deleteBtn.addEventListener('click', deleteCurrentHike);

  // ── Initialize Leaflet map & layers ────────────────────
  map = L.map('map', { preferCanvas: true, zoomControl: false }).setView([41.7151, 44.8271], 13);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const topo = L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, detectRetina: true,
    attribution: '© OSM, SRTM | OpenTopoMap',
    crossOrigin: true
  }).addTo(map);

  const osmStd = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap contributors',
    crossOrigin: true
  });

  const trails = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© Waymarked Trails',
    crossOrigin: true
  });

  L.control.layers({ 'Topo': topo, 'OSM Standard': osmStd }, { 'Trails': trails }, { position: 'bottomright' }).addTo(map);

  // ── Drawing toolbar: only polyline ─────────────────────
  drawnItems = new L.FeatureGroup().addTo(map);
  drawControl = new L.Control.Draw({
    position: 'topright',
    draw: { polyline: true, polygon: false, rectangle: false, circle: false, circlemarker: false, marker: false },
    edit: false
  });
  map.addControl(drawControl);

  // ── Load and render initial hikes.json ─────────────────
  fetch('hikes.json', { cache: 'no-store' })
    .then(res => { if (!res.ok) throw new Error('Could not load hikes.json'); return res.json(); })
    .then(data => { data.forEach(addExistingHike); renderHikeList(); })
    .catch(console.error);

  // ── Download current hikes as JSON ─────────────────────
  document.getElementById('download-json').addEventListener('click', () => {
    const dataToSave = hikes.map(({ layer, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(dataToSave, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'hikes.json'; a.click();
    URL.revokeObjectURL(url);
  });

  // ── Cancel form (new or edit) ──────────────────────────
  document.getElementById('cancel-hike').addEventListener('click', () => {
    if (pendingLayer && !pendingEditHike) drawnItems.removeLayer(pendingLayer);
    pendingLayer = pendingEditHike = null;
    form.classList.add('hidden');
    deleteBtn.classList.add('hidden');
  });

  // ── Save (new or edit metadata) ────────────────────────
  document.getElementById('save-hike').addEventListener('click', async () => {
    if (!pendingLayer) return;
    const name       = nameInput.value.trim() || 'Unnamed Hike';
    const start      = startInput.value || null;
    const end        = endInput.value || null;
    const distance   = parseFloat(distInput.value) || 0;
    const difficulty = parseInt(difficultyInput.value) || 0;
    const mappy      = mappyInput.value.trim() || null;
    const photos     = photosInput.value.trim() || null;
    const media      = mediaInput.value.trim() || null;

    if (pendingEditHike) {
      Object.assign(pendingEditHike, { name, startDate: start, endDate: end, distance, difficulty, mappyLink: mappy, photosLink: photos, mediaLink: media });
      pendingLayer.setTooltipContent(`${distance.toFixed(2)} km`);
    } else {
      const id = pendingLayer._leaflet_id;
      pendingLayer.bindTooltip(`${distance.toFixed(2)} km`, { permanent: true, direction: 'center', className: 'my-distance-tooltip' }).openTooltip();
      hikes.push({
        id, name, distance, difficulty,
        route: { type: 'LineString', coordinates: pendingLayer.routeCoords },
        startDate: start, endDate: end, mappyLink: mappy, photosLink: photos, mediaLink: media,
        layer: pendingLayer
      });
    }

    pendingLayer = pendingEditHike = null;
    form.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    renderHikeList();
  });

  // ── When drawing a new polyline: snap to *foot* network ─
  map.on('draw:created', async e => {
    const layer = e.layer;
    drawnItems.addLayer(layer);

    const raw = layer.toGeoJSON().geometry.coordinates; // [lng,lat]
    let matched = await osrmMatchFoot(raw);

    // fallback: keep the user's sketch if matching fails
    const route = matched && matched.length ? matched : densify(raw, 2);

    drawnItems.removeLayer(layer);
    pendingLayer = L.polyline(route.map(c => [c[1], c[0]])).addTo(drawnItems);
    pendingLayer.routeCoords = route;

    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value = dist.toFixed(2);
    nameInput.value = startInput.value = endInput.value = '';
    difficultyInput.value = mappyInput.value = photosInput.value = mediaInput.value = '';
    form.classList.remove('hidden');
    deleteBtn.classList.add('hidden');
  });
};

// ── Create a new label+input in the form ─────────────────
function createFormField(labelText, id, type) {
  const label = document.createElement('label');
  label.innerHTML = `${labelText}<br/>`;
  const input = document.createElement('input');
  input.type = type; input.id = id;
  input.style.width = '100%';
  input.style.marginBottom = '8px';
  label.appendChild(input);
  const br = document.createElement('br');
  const saveBtn = document.getElementById('save-hike');
  form.insertBefore(label, saveBtn);
  form.insertBefore(br, saveBtn);
  return input;
}

// ── Render the sidebar list, sorted by the chosen criterion ─
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
      case 'distanceDesc':   return b.distance - a.distance;
      case 'distanceAsc':    return a.distance - b.distance;
      case 'difficultyDesc': return (b.difficulty || 0) - (a.difficulty || 0);
      case 'difficultyAsc':  return (a.difficulty || 0) - (b.difficulty || 0);
      case 'nameAsc':        return a.name.localeCompare(b.name);
      case 'nameDesc':       return b.name.localeCompare(a.name);
      default:               return 0;
    }
  });

  sorted.forEach(hike => {
    if (!hike.layer) {
      hike.layer = drawnItems.getLayers().find(l => l._leaflet_id === hike.id);
    }
    const li = document.createElement('li');
    li.dataset.id = hike.id;
    li.textContent = buildListText(hike);
    li.onclick = () => {
      map.fitBounds(hike.layer.getBounds());
      pendingEditHike = hike;
      pendingLayer = hike.layer;
      form.classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      nameInput.value = hike.name;
      startInput.value = hike.startDate || '';
      endInput.value = hike.endDate || '';
      distInput.value = hike.distance.toFixed(2);
      difficultyInput.value = hike.difficulty || '';
      mappyInput.value = hike.mappyLink || '';
      photosInput.value = hike.photosLink || '';
      mediaInput.value = hike.mediaLink || '';
    };
    list.appendChild(li);
  });
}

// ── Delete the currently editing hike ────────────────────
function deleteCurrentHike() {
  if (!pendingEditHike || !pendingLayer) return;
  drawnItems.removeLayer(pendingLayer);
  hikes = hikes.filter(h => h.id !== pendingEditHike.id);
  pendingEditHike = pendingLayer = null;
  form.classList.add('hidden');
  deleteBtn.classList.add('hidden');
  renderHikeList();
}

// ── Handle uploading a JSON file of hikes ────────────────
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
    } catch (err) {
      console.error('Invalid JSON', err);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
}

// ── Add an existing hike (from initial load or upload) ───
function addExistingHike(h) {
  const layer = L.geoJSON(h.route).addTo(drawnItems);
  const id = (h && 'id' in h && h.id != null) ? h.id : layer._leaflet_id;
  layer._leaflet_id = id;

  let distance = typeof h.distance === 'number'
    ? h.distance
    : (function () { try { return turf.length(h.route, { units: 'kilometers' }); } catch { return 0; } })();
  distance = Number.isFinite(distance) ? distance : 0;

  layer.bindTooltip(`${distance.toFixed(2)} km`, { permanent: true, direction: 'center', className: 'my-distance-tooltip' }).openTooltip();

  hikes.push({
    id,
    name: h.name || 'Unnamed Hike',
    distance,
    difficulty: h.difficulty ?? null,
    route: h.route,
    startDate: h.startDate || null,
    endDate: h.endDate || null,
    mappyLink: h.mappyLink || null,
    photosLink: h.photosLink || null,
    mediaLink: h.mediaLink || null,
    layer
  });
}

// ── Build the text for a list item ───────────────────────
function buildListText(h) {
  let txt = h.name;
  if (h.startDate && h.endDate) txt += ` (${h.startDate} - ${h.endDate})`;
  else if (h.startDate) txt += ` (${h.startDate})`;
  txt += ` - ${h.distance.toFixed(2)} km`;
  if (h.difficulty !== undefined && h.difficulty !== null && h.difficulty !== '') {
    txt += ` - ${h.difficulty}/10`;
  }
  return txt;
}
