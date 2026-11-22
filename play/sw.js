// Pickleball Südbaden e.V. · session organiser · offline cache.
// Scope /play/. Caches every file the tool needs on the first visit, then serves from the cache,
// so the tool works in airplane mode. A new version installs in the background and waits until
// every window of the tool is closed (no skipWaiting), so it never disturbs a running session.
// Served by a hub (any host other than the club site, for example http://localhost:15120 on the
// laptop), the files come from the hub first and the cache is only the fallback: the hub serves
// whatever is on the laptop, so a plain reload always gets the newest version.
// Bump VERSION whenever a cached file changes.

const VERSION = 'play-v10';
const SITE = /(^|\.)pickleball-suedbaden\.de$/.test(self.location.hostname);
const FILES = [
  './',
  'index.html',
  'play.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/session.js',
  'js/draw.js',
  'js/i18n.js',
  'js/store.js',
  'js/audio.js',
  'js/hub.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  '../assets/site.css',
  '../assets/img/logo-mark-on-dark.png',
  '../assets/img/favicon.svg',
  '../assets/img/favicon-32.png',
  '../assets/fonts/saira/saira-latin-standard-italic.woff2',
  '../assets/fonts/saira/saira-latin-ext-standard-italic.woff2',
  '../assets/fonts/saira/saira-latin-standard-normal.woff2',
  '../assets/fonts/saira/saira-latin-ext-standard-normal.woff2',
  '../assets/fonts/inter/inter-latin-wght-normal.woff2',
  '../assets/fonts/inter/inter-latin-ext-wght-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  // Runs on the first install, or once every window of the old version is closed. Taking control
  // then cannot disturb a running session.
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('play-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Never cache the hub's API: state and events always come live from the hub.
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/play/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (!SITE) {
      try { return await fetch(req, { cache: 'no-cache' }); } catch (e) { /* hub down: use the cache */ }
    }
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('./') : undefined);
    if (hit) return hit;
    try { return await fetch(req); } catch (e) { return (await cache.match('./')) || Response.error(); }
  })());
});
