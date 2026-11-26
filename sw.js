// Service worker: guarda la app para que abra sin conexión.
// Sube VERSION cuando cambies archivos para que se actualice la copia.
const VERSION = 'v1';
const CACHE = 'chromatic-' + VERSION;
const FILES = [
  './', 'index.html', 'style.css', 'manifest.webmanifest', 'icon.ico',
  'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png',
  'js/app.js', 'js/dsp.js', 'js/praat.js', 'js/wav.js', 'js/zip.js', 'js/dwp.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Red primero (siempre la versión nueva si hay conexión), caché si no hay.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
