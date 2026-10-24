// Service worker: deja la app abrible sin conexión (los datos necesitan red).
// Sube el número de versión al publicar cambios para forzar la actualización.
const CACHE = 'entregas-v2';
const SHELL = [
  './', './index.html', './app.js', './styles.css', './config.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname.endsWith('supabase.co')) return; // datos: siempre en red

  if (url.origin === location.origin) {
    // Archivos propios: red primero (para recibir actualizaciones), caché si no hay red
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
  } else {
    // Librerías de CDN (versión fija): caché primero
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
