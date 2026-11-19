const V = 'moonios-v2';
const ASSETS = ['./', './index.html', './app.js?v=2', './manifest.webmanifest', './icon-180.png', './icon-512.png',
  './vendor/jszip.min.js', './vendor/sql-wasm.js', './vendor/sql-wasm.wasm', './vendor/pdf.min.mjs', './vendor/pdf.worker.min.mjs', './vendor/peerjs.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(V).then(ca => ca.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
});
