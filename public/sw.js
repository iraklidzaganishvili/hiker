// sw.js — Service Worker: network-first tile cache for Hiker
const CACHE_NAME = 'hiker-tiles-v1';

const TILE_DOMAINS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'basemaps.cartocdn.com',
  'server.arcgisonline.com',
  'tile.waymarkedtrails.org'
];

function isTileRequest(url) {
  return TILE_DOMAINS.some(domain => url.hostname.includes(domain));
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle tile requests — let everything else pass through
  if (!isTileRequest(url)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Clone and cache the successful network response
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Network failed — try the cache
        return caches.open(CACHE_NAME).then(cache => {
          return cache.match(event.request);
        });
      })
  );
});
