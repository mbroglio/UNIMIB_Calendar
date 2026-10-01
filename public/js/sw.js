const CACHE_NAME = 'unimib-calendar-v6';
const ASSETS = [
  '/',
  '/css/style.css',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) {
    // Network first for API, fallback to cache
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const resClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, resClone);
          });
          return response;
        })
        .catch(() => caches.match(event.request))
    );
  } else {
    // Cache first for static assets (shared links like /?anno=... reuse the cached page)
    event.respondWith(
      caches.match(event.request, { ignoreSearch: event.request.mode === 'navigate' }).then((cached) => {
        return cached || fetch(event.request);
      })
    );
  }
});
