// Offline support: serve the app from cache when there is no connection.
// Network first so updates show up as soon as they are published.
const CACHE = 'elmansy-v1';
const SHELL = ['./', 'index.html', 'platform.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
const CACHEABLE = u => u.origin === location.origin || /(^|\.)gstatic\.com$/.test(u.hostname) || /fonts\.googleapis\.com$/.test(u.hostname);
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || !CACHEABLE(u)) return; // Firebase data traffic goes straight to the network
  e.respondWith(fetch(e.request).then(r => {
    if (r && (r.ok || r.type === 'opaque')) { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});
