// Network-first: always serve the latest local files while the launcher is running,
// fall back to the cache only when offline. (Cache-first served stale app.js after edits.)
const CACHE_NAME = 'gaze-experiment-20261029-3';
const APP_FILES = ['./', './index.html', './analysis.html', './styles.css?v=20261029-2', './viz.css?v=20261023-1', './viz.js?v=20261023-1', './app.js?v=20261029-3', './gaze-filter.js?v=20261028-1', './game.js?v=20261029-3', './result-image.js?v=20261029-3', './tracker-mediapipe.js?v=20261023-1', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
      return response;
    }).catch(() => caches.match(request))
  );
});
