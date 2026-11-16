// Offline shell: with an on-device model, Red Pen keeps working with no connection.
const CACHE = 'redpen-v1';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/ai.js', 'js/privacy.js', 'js/demo.js', 'js/firebase-config.js', 'manifest.webmanifest', 'icons/icon.svg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const cacheable = e.request.method === 'GET' && (url.origin === location.origin || url.hostname === 'www.gstatic.com' || url.hostname.endsWith('fonts.googleapis.com') || url.hostname.endsWith('fonts.gstatic.com'));
  if (!cacheable) return; // AI and App Check calls always go to the network
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
