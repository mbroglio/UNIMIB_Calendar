const CACHE_NAME = 'unimib-calendar-v24';
const FONTS_CACHE_NAME = 'unimib-fonts-v1';
const MAX_API_ENTRIES = 50;

const ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/alpine.min.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/ottaedro.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon-32.png'
];

function trimCache(cacheName, maxItems) {
  caches.open(cacheName).then((cache) => {
    return cache.keys().then((keys) => {
      if (keys.length > maxItems) {
        return cache.delete(keys[0]).then(() => trimCache(cacheName, maxItems));
      }
      return undefined;
    });
  }).catch(() => {});
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn(`[SW] Impossibile mettere in cache l'asset: ${asset}`, err);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== FONTS_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // 1. Google Fonts Cache (PT Sans official university typography offline resilience)
  if (requestUrl.origin === 'https://fonts.googleapis.com' || requestUrl.origin === 'https://fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONTS_CACHE_NAME).then(async (fontCache) => {
        const cachedResponse = await fontCache.match(event.request);
        if (cachedResponse) {
          return cachedResponse;
        }
        try {
          const networkResponse = await fetch(event.request);
          if (networkResponse && networkResponse.status === 200) {
            void fontCache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return cachedResponse || new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  // Ignore other cross-origin requests (e.g. api.qrserver.com)
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // 2. API Requests: Network-first, only cache successful GET 200 responses with bounded size
  if (requestUrl.pathname.startsWith('/api/')) {
    if (event.request.method !== 'GET') {
      return;
    }

    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && response.status === 200) {
            const resClone = response.clone();
            void caches.open(CACHE_NAME).then((cache) => {
              void cache.put(event.request, resClone);
              trimCache(CACHE_NAME, MAX_API_ENTRIES);
            });
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 3. Static Assets: Stale-while-revalidate
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const matchOptions = event.request.mode === 'navigate' ? { ignoreSearch: true } : {};
      const cached = await cache.match(event.request, matchOptions);

      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            void cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(fetchPromise);
        return cached;
      }

      const networkResponse = await fetchPromise;
      if (networkResponse) {
        return networkResponse;
      }

      // Offline fallback for navigation requests
      if (event.request.mode === 'navigate') {
        const fallback = await cache.match('/', { ignoreSearch: true });
        if (fallback) return fallback;
      }

      return new Response('Offline - Risorsa non disponibile', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    })
  );
});
