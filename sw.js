const V = 'moonios-v3';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-512.png',
  './js/core.js?v=3', './js/library.js?v=3', './js/reader.js?v=3', './js/extras.js?v=3',
  './vendor/jszip.min.js', './vendor/sql-wasm.js', './vendor/sql-wasm.wasm', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs',
  './vendor/peerjs.min.js', './vendor/opencc-full.js', './up/'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(ASSETS.map(a => c.add(new Request(a, { cache: 'reload' })).catch(err => console.warn('precache', a, err))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    const isUp = /\/up\/?$/.test(url.pathname);
    e.respondWith(caches.match(isUp ? './up/' : './index.html').then(cached => {
      const net = fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(isUp ? './up/' : './index.html', cp)); } return r; }).catch(() => cached);
      return cached || net;
    }));
    return;
  }
  e.respondWith(caches.match(req).then(cached => {
    const net = fetch(req).then(r => { if (r.ok) { const cp = r.clone(); caches.open(V).then(c => c.put(req, cp)); } return r; }).catch(() => cached);
    return cached || net;
  }));
});
