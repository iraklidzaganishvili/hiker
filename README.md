# Hiker

A trail log for my hiking group: every hike we do goes on one map, with its route, distance, difficulty, who came, and links to photos.

**Demo:** [iraklidzaganishvili.github.io/hiker](https://iraklidzaganishvili.github.io/hiker/) is a static snapshot of the group's data (49 routes, 764 km) on the earlier, backend-free version of the app. The full app below, with hikers, the leaderboard and the mobile layout, runs self-hosted for the group.

## Features

- **Map:** Leaflet with OpenTopoMap, OpenStreetMap, satellite and Waymarked Trails layers.
- **GPX import:** a recorded track is snapped onto the real trail with OSRM foot map-matching, then simplified with Turf.js (about 5 m tolerance) to keep the data small.
- **Hike details:** name, dates, distance, difficulty, notes, hikers, and links to the route, photos and media.
- **Hikes list:** sortable by date, distance, difficulty or name.
- **Leaderboard:** hikes, distance and points per hiker. Tap a hiker to filter both the map and the list to their hikes.
- **Mobile:** a bottom sheet with collapsed, half and full states.
- **Read-only mode:** anyone can browse. Editing needs a password.

## How it's built

| Path | What it is |
|---|---|
| `server.js` | Express backend: serves `public/`, a public `GET /api/hikes`, and password-protected `POST /api/hikes` (atomic write to `data/hikes.json`) with a rate-limited `POST /api/auth`. |
| `public/` | The full app (Leaflet, Turf.js, OSRM), installable as a PWA via `sw.js`. |
| `index.html`, `script.js`, `style.css`, `hikes.json` | The static, backend-free version served by GitHub Pages, reading a snapshot of the data from `hikes.json`. |
| `scripts/simplify-hikes.js` | One-time migration that simplified stored routes and gave each hike a stable ID. |

## Run it locally

```bash
npm install
echo "HIKE_PASSWORD=choose-a-password" > .env
npm start   # http://localhost:10000
```

Hikes are stored in `data/hikes.json`.
