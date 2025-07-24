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

  // ── Dynamically add difficulty numeric field ─────────────
  difficultyInput = createFormField('Difficulty (1-10):', 'hike-difficulty', 'number');
  difficultyInput.min = 1;
  difficultyInput.max = 10;
  difficultyInput.step = 1;

  // ── Dynamically add the 3 optional link fields ──────────
  mappyInput  = createFormField('Mappy Link (optional):', 'hike-mappy-link', 'url');
  photosInput = createFormField('Photos Link (optional):', 'hike-photos-link', 'url');
  mediaInput  = createFormField('Media Link (optional):', 'hike-media-link', 'url');

  form.classList.add('hidden');
  const sidebar = document.getElementById('sidebar');

  // ── Hidden file-input & "Load JSON" button ──────────────
  const fileInput = document.createElement('input');
  fileInput.type    = 'file';
  fileInput.accept  = '.json';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', handleUpload);
  sidebar.appendChild(fileInput);

  const loadBtn = document.createElement('button');
  loadBtn.id          = 'load-json';
  loadBtn.textContent = 'Load JSON';
  loadBtn.style.width        = '100%';
  loadBtn.style.padding      = '8px';
  loadBtn.style.marginBottom = '10px';
  sidebar.insertBefore(loadBtn, document.getElementById('download-json'));
  loadBtn.addEventListener('click', () => fileInput.click());

  // ── "Add Hikes" button for manual coords ────────────────
  const addCoordsBtn = document.createElement('button');
  addCoordsBtn.id          = 'add-hikes';
  addCoordsBtn.textContent = 'Add Hikes';
  addCoordsBtn.style.width        = '100%';
  addCoordsBtn.style.padding      = '8px';
  addCoordsBtn.style.marginBottom = '10px';
  sidebar.insertBefore(addCoordsBtn, loadBtn.nextSibling);
  addCoordsBtn.addEventListener('click', () => {
    const input = prompt('Enter coordinates eg. [[44.8271, 41.7151],[44.8285, 41.7160],[44.8300, 41.7200],[44.8320, 41.7220]]:');
    if (!input) return;
    let coords;
    try {
      coords = JSON.parse(input);
      if (!Array.isArray(coords) || coords.length < 2) throw new Error();
    } catch (err) {
      alert('Invalid format. Please enter a JSON array like [[lng,lat],[lng,lat],...]');
      return;
    }
    const route = coords;
    const latlngs = route.map(c => [c[1], c[0]]);
    const layer = L.polyline(latlngs).addTo(drawnItems);
    pendingLayer = layer;
    pendingLayer.routeCoords = route;

    // compute distance
    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value = dist.toFixed(2);
    nameInput.value = '';
    startInput.value = '';
    endInput.value = '';
    difficultyInput.value = '';
    mappyInput.value = '';
    photosInput.value = '';
    mediaInput.value = '';
    form.classList.remove('hidden');
    deleteBtn.classList.add('hidden');
  });

  // ── Sorting dropdown ────────────────────────────────────
  sortSelect = document.createElement('select');
  sortSelect.id    = 'sort-select';
  sortSelect.style.width        = '100%';
  sortSelect.style.padding      = '8px';
  sortSelect.style.marginBottom = '10px';
  [
    { value: 'dateDesc', text: 'Date (Newest First)'      },
    { value: 'dateAsc',  text: 'Date (Oldest First)'      },
    { value: 'distanceDesc', text: 'Distance (Longest First)'  },
    { value: 'distanceAsc',  text: 'Distance (Shortest First)' },
    { value: 'difficultyDesc', text: 'Difficulty (Hardest First)' },
    { value: 'difficultyAsc',  text: 'Difficulty (Easiest First)' },
    { value: 'nameAsc',    text: 'Name (A–Z)'               },
    { value: 'nameDesc',   text: 'Name (Z–A)'               }
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.text;
    sortSelect.appendChild(o);
  });
  sortSelect.addEventListener('change', renderHikeList);
  sidebar.insertBefore(sortSelect, loadBtn);

  // ── Delete button (shown when editing) ─────────────────
  deleteBtn = document.createElement('button');
  deleteBtn.id          = 'delete-hike';
  deleteBtn.textContent = 'Delete';
  deleteBtn.style.marginRight = '5px';
  deleteBtn.classList.add('hidden');
  document.getElementById('cancel-hike')
          .insertAdjacentElement('afterend', deleteBtn);
  deleteBtn.addEventListener('click', deleteCurrentHike);

  // ── Initialize Leaflet map & layers ────────────────────
  map = L.map('map', { preferCanvas: true }).setView([41.7151, 44.8271], 13);
  const topo = L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, detectRetina: true,
    attribution: '© OSM, SRTM | OpenTopoMap'
  }).addTo(map);
  const osmHot = L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OSM HOT'
  });
  const trails = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© Waymarked Trails'
  });
  L.control.layers(
    { 'Topo': topo, 'OSM HOT': osmHot },
    { 'Trails': trails }
  ).addTo(map);

  // ── Drawing toolbar: only polyline ──────────────────────
  drawnItems = new L.FeatureGroup().addTo(map);
  drawControl = new L.Control.Draw({
    draw:  { polyline: true, polygon: false, rectangle: false, circle: false, circlemarker: false, marker: false },
    edit: false
  });
  map.addControl(drawControl);

  // ── Load and render initial hikes.json ─────────────────
  fetch('hikes.json')
    .then(res => {
      if (!res.ok) throw new Error('Could not load hikes.json');
      return res.json();
    })
    .then(data => {
      data.forEach(addExistingHike);
      renderHikeList();
    })
    .catch(console.error);

  // ── Download current hikes as JSON ──────────────────────
  document.getElementById('download-json').addEventListener('click', () => {
    const dataToSave = hikes.map(({ layer, ...rest }) => rest);
    const blob = new Blob([JSON.stringify(dataToSave, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'hikes.json';
    a.click();
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
    const end        = endInput.value   || null;
    const distance   = parseFloat(distInput.value) || 0;
    const difficulty = parseInt(difficultyInput.value) || 0;
    const mappy      = mappyInput.value.trim() || null;
    const photos     = photosInput.value.trim()|| null;
    const media      = mediaInput.value.trim() || null;

    if (pendingEditHike) {
      // metadata edit only
      Object.assign(pendingEditHike, {
        name,
        startDate: start,
        endDate: end,
        distance,
        difficulty,
        mappyLink: mappy,
        photosLink: photos,
        mediaLink: media
      });
      pendingLayer.setTooltipContent(`${distance.toFixed(2)} km`);
    } else {
      // new hike; layer already has routeCoords
      const id = pendingLayer._leaflet_id;
      pendingLayer.bindTooltip(
        `${distance.toFixed(2)} km`,
        { permanent: true, direction: 'center', className: 'my-distance-tooltip' }
      ).openTooltip();

      hikes.push({
        id,
        name,
        distance,
        difficulty,
        route: { type: 'LineString', coordinates: pendingLayer.routeCoords },
        startDate: start,
        endDate: end,
        mappyLink: mappy,
        photosLink: photos,
        mediaLink: media,
        layer: pendingLayer
      });
    }

    pendingLayer = pendingEditHike = null;
    form.classList.add('hidden');
    deleteBtn.classList.add('hidden');
    renderHikeList();
  });

  // ── When drawing a new polyline ────────────────────────
  map.on('draw:created', async e => {
    const layer = e.layer;
    pendingLayer = layer;
    drawnItems.addLayer(layer);

    // snap each segment via OSRM
    const pts = layer.toGeoJSON().geometry.coordinates;
    let route  = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [lng1, lat1] = pts[i];
      const [lng2, lat2] = pts[i + 1];
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/foot/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson`
      ).then(r => r.json()).catch(() => null);
      if (res?.routes?.length) route = route.concat(res.routes[0].geometry.coordinates);
    }
    // dedupe & redraw snapped
    route = route.filter((c,i) => i===0 || c[0]!==route[i-1][0] || c[1]!==route[i-1][1]);
    drawnItems.removeLayer(pendingLayer);
    pendingLayer = L.polyline(route.map(c => [c[1], c[0]])).addTo(drawnItems);
    pendingLayer.routeCoords = route;

    // compute distance & reset form
    const dist = turf.length(turf.lineString(route), { units: 'kilometers' });
    distInput.value   = dist.toFixed(2);
    nameInput.value   = '';
    startInput.value  = '';
    endInput.value    = '';
    difficultyInput.value = '';
    mappyInput.value  = '';
    photosInput.value = '';
    mediaInput.value  = '';
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
    switch(mode) {
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
      case 'distanceDesc': return b.distance - a.distance;
      case 'distanceAsc':  return a.distance - b.distance;
      case 'difficultyDesc': return (b.difficulty||0) - (a.difficulty||0);
      case 'difficultyAsc':  return (a.difficulty||0) - (b.difficulty||0);
      case 'nameAsc':    return a.name.localeCompare(b.name);
      case 'nameDesc':   return b.name.localeCompare(a.name);
      default: return 0;
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
      pendingLayer    = hike.layer;
      form.classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      nameInput.value   = hike.name;
      startInput.value  = hike.startDate || '';
      endInput.value    = hike.endDate   || '';
      distInput.value   = hike.distance.toFixed(2);
      difficultyInput.value = hike.difficulty || '';
      mappyInput.value  = hike.mappyLink  || '';
      photosInput.value = hike.photosLink || '';
      mediaInput.value  = hike.mediaLink  || '';
    };
    list.appendChild(li);
  });
}

// ── Delete the currently editing hike ─────────────────────
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

// ── Add an existing hike (from initial load or upload) ────
function addExistingHike(h) {
  const layer = L.geoJSON(h.route).addTo(drawnItems);
  layer._leaflet_id = h.id;
  layer.bindTooltip(
    `${h.distance.toFixed(2)} km`,
    { permanent: true, direction: 'center', className: 'my-distance-tooltip' }
  ).openTooltip();

  hikes.push({ ...h, layer });
}

// ── Build the text for a list item ───────────────────────
function buildListText(h) {
  let txt = h.name;
  if (h.startDate && h.endDate)      txt += ` (${h.startDate} - ${h.endDate})`;
  else if (h.startDate)              txt += ` (${h.startDate})`;
  txt += ` - ${h.distance.toFixed(2)} km`;
  if (h.difficulty !== undefined)    txt += ` - ${h.difficulty}/10`;
  return txt;
}
