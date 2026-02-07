/* sw.js - PP-01 ACOPAC PWA (offline shell) */
const VERSION = 'pp01-pwa-v1.0.1';
const CACHE_NAME = `pp01-cache-${VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k.startsWith('pp01-cache-') && k !== CACHE_NAME) ? caches.delete(k) : null));
    self.clients.claim();
  })());
});

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;

  const res = await fetch(req);
  if (req.method === 'GET' && res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (req.method === 'GET' && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only same-origin. Do not cache external APIs (Pl@ntNet, Sheets, tiles) here.
  if (url.origin !== self.location.origin) return;

  // Navigations: keep app updated when online, fallback to cache offline.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst('./index.html'));
    return;
  }

  // Default: cache-first for same-origin assets.
  event.respondWith(cacheFirst(req));
});
