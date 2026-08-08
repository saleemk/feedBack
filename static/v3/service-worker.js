const CACHE_PREFIX = 'feedback-pwa-offline-';
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_URL = '/static/v3/offline.html';
const APP_ENTRY_PATHS = new Set(['/', '/v3', '/v3/']);
const TRANSIENT_UNAVAILABLE_STATUSES = new Set([502, 503, 504]);

async function offlineResponse() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match(OFFLINE_URL)) || Response.error();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !APP_ENTRY_PATHS.has(url.pathname)) return;

  const networkRequest = new Request(event.request, { cache: 'no-store' });
  event.respondWith(
    fetch(networkRequest)
      .then((response) => (
        TRANSIENT_UNAVAILABLE_STATUSES.has(response.status)
          ? offlineResponse()
          : response
      ))
      .catch(() => offlineResponse())
  );
});
