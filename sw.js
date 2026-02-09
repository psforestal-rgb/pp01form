/* sw.js - PP-01 ACOPAC PWA v1.5.0 (Fix WMS HTTPS) */
const VERSION = 'pp01-pwa-v1.5.0-fix';
const CACHE_NAME = `pp01-cache-${VERSION}`;
const TILE_CACHE = 'pp01-tiles-v1'; 

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* Tiles base (OpenTopo, Google, Esri) */
const TILE_HOSTS = [
  'tile.opentopomap.org',
  'mt0.google.com', 'mt1.google.com', 'mt2.google.com', 'mt3.google.com',
  'server.arcgisonline.com',
  'ecn.t0.tiles.virtualearth.net', 'ecn.t1.tiles.virtualearth.net',
  'ecn.t2.tiles.virtualearth.net', 'ecn.t3.tiles.virtualearth.net'
];

/* WMS Hosts - Asegurados HTTPS */
const WMS_HOSTS = [
  'siri.snitcr.go.cr',
  'geos.snitcr.go.cr',
  'mapas.da.go.cr'
];

/* 1x1 Transparent PNG for offline fallback */
const EMPTY_TILE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==';

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Intentar cachear shell, no fallar si falta algún icono
    try { await cache.addAll(APP_SHELL); } catch(e) { console.warn('Shell partial cache', e); }
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('pp01-cache-') && k !== CACHE_NAME) return caches.delete(k);
      return null;
    }));
    self.clients.claim();
  })());
});

// Estrategia Cache-First para Tiles
async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    // Solo cachear respuestas válidas (200 OK)
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Si falla (offline) y es una imagen, devolver transparente
    if (req.headers.get('Accept').includes('image')) {
        const bytes = Uint8Array.from(atob(EMPTY_TILE_B64), c => c.charCodeAt(0));
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    throw e;
  }
}

// Estrategia Network-First para HTML (App Shell updates)
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
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

  // 1. Tiles Mapas Base
  if (TILE_HOSTS.some(h => url.hostname.endsWith(h))) {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  // 2. WMS
  if (WMS_HOSTS.some(h => url.hostname === h)) {
    // Cachear GetMap (imágenes), ignorar GetFeatureInfo (datos)
    if (url.search.toLowerCase().includes('request=getmap')) {
        event.respondWith(tileCacheFirst(req));
    }
    return;
  }

  // 3. CDNs Externos (Leaflet, FA)
  if (url.hostname.includes('unpkg.com') || url.hostname.includes('cloudflare.com')) {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  // 4. Navegación principal
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  // 5. Default Cache First
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
  );
});