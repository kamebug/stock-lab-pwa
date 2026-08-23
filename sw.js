// BUILD_ID: 2608240535 (JST, aammddhhmm)
const CACHE_VERSION = "stocklab-2608240535";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Assets do próprio app: cache-first (funciona offline)
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((resp) => {
          const respClone = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, respClone));
          return resp;
        });
      })
    );
    return;
  }

  // Bibliotecas externas (CDN): network-first com fallback para cache
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const respClone = resp.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, respClone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
