// Minimal PWA service worker: network-first (this is a dev tool under active iteration, so
// always prefer the freshest JS), falling back to cache when offline/unreachable — mainly so
// the shell still loads if you're testing on a phone with a flaky connection to this Mac.
const CACHE = 'osmo-ble-v1';
// Every module the page imports, so the offline shell actually starts. tests/unit/node/
// gimbal_page_wiring.test.ts fails when the page imports something this list leaves out.
const ASSETS = [
  './',
  './index.html',
  './app.mjs',
  './backend-client.mjs',
  './controls.mjs',
  './coverage.mjs',
  './frame-log.mjs',
  './joystick.mjs',
  './orientation.mjs',
  './page-state.mjs',
  './ui.mjs',
  './manifest.json',
  './icon.svg',
  '../protocol/commands.mjs',
  '../protocol/constants.mjs',
  '../protocol/dome.mjs',
  '../protocol/duml.mjs',
  '../protocol/phone_telemetry.mjs',
  '../protocol/stall.mjs',
  '../protocol/telemetry.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
