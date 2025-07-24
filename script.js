let hikes = [];
let map;

window.onload = () => {
  // Initialize map
  map = L.map('map').setView([41.7151, 44.8271], 13);
  
  // Base topographic layer
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '© OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap'
  }).addTo(map);

  // Hiking trails overlay
  L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: 'Hiking routes © Waymarked Trails'
  }).addTo(map);

  // Feature group for drawn items
  const drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  // Draw control
  const drawControl = new L.Control.Draw({
    edit: { featureGroup: drawnItems },
    draw: {
      polyline: true,
      polygon: false,
      rectangle: false,
      circle: false,
      marker: false,
      circlemarker: false
    }
  });
  map.addControl(drawControl);

  // Handle new route drawing
  map.on('draw:created', e => {
    const layer = e.layer;
    const coords = layer.toGeoJSON().geometry.coordinates;
    const name = prompt('Enter hike name:');
    const date = prompt('Enter hike date (YYYY-MM-DD):');
    if (name && date) {
      const hike = { name, date, route: { type: 'LineString', coordinates: coords } };
      hikes.push(hike);
      drawnItems.addLayer(layer);
      addHikeToList(hike);
    }
  });

  // Load existing hikes
  fetch('hikes.json')
    .then(res => res.json())
    .then(data => {
      hikes = data;
      hikes.forEach(hike => {
        const layer = L.geoJSON(hike.route).addTo(drawnItems);
        addHikeToList(hike);
      });
    });

  // Download JSON
  document.getElementById('download-json').onclick = () => {
    const blob = new Blob([JSON.stringify(hikes, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hikes.json';
    a.click();
    URL.revokeObjectURL(url);
  };
};

function addHikeToList(hike) {
  const li = document.createElement('li');
  li.textContent = `${hike.name} (${hike.date})`;
  li.onclick = () => {
    map.fitBounds(L.geoJSON(hike.route).getBounds());
  };
  document.getElementById('hike-list').appendChild(li);
}