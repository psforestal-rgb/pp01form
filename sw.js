/* sw.js - PP-01 ACOPAC PWA v1.4.0 (offline shell + tile cache) */
const VERSION = 'pp01-pwa-v1.4.4';
const CACHE_NAME = `pp01-cache-${VERSION}`;
const TILE_CACHE = 'pp01-tiles-v1'; // Persistente entre actualizaciones de la app

const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './sw.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* Dominios de tiles base (cache-first para uso offline) */
const TILE_HOSTS = [
  'tile.opentopomap.org',
  'mt0.google.com', 'mt1.google.com', 'mt2.google.com', 'mt3.google.com',
  'server.arcgisonline.com',
  'ecn.t0.tiles.virtualearth.net', 'ecn.t1.tiles.virtualearth.net',
  'ecn.t2.tiles.virtualearth.net', 'ecn.t3.tiles.virtualearth.net'
];

/* Dominios WMS (tiles GetMap se cachean, GetFeatureInfo pasa directo) */
const WMS_HOSTS = [
  'siri.snitcr.go.cr',
  'geos.snitcr.go.cr',
  'mapas.da.go.cr'
];

/* 1x1 PNG transparente para tiles fallback offline */
const EMPTY_TILE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAAlwSFlzAAAWJQAAFiUBSVIk8AAAAA0lEQVQI12P4z8BQDwAEgAF/QualzQAAAABJRU5ErkJggg==';

// Límite de tiles en caché
const TILE_CACHE_MAX_ITEMS = 2000; // ajustable
const TILE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// ── Install ──
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

// ── Activate: limpiar caches viejos PERO mantener TILE_CACHE con límite ──
async function cleanTileCache() {
    const cache = await caches.open(TILE_CACHE);
    const requests = await cache.keys();
    if (requests.length <= TILE_CACHE_MAX_ITEMS) return;

    // Obtener metadatos de tiempo (no tenemos, así que simplemente eliminamos los más antiguos)
    // Podríamos almacenar timestamps en una base aparte, pero por simplicidad:
    const toDelete = requests.length - TILE_CACHE_MAX_ITEMS;
    for (let i = 0; i < toDelete; i++) {
        await cache.delete(requests[i]);
    }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('pp01-cache-') && k !== CACHE_NAME) return caches.delete(k);
    }));
    await cleanTileCache(); // <-- nuevo
    self.clients.claim();
  })());
});

// ── Estrategia cache-first para tiles (con fallback offline) ──
async function tileCacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;

  try {
    const res = await fetch(req);
    // Solo cachear respuestas exitosas con content-type de imagen
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('image') || ct.includes('png') || ct.includes('jpeg') || ct.includes('octet-stream')) {
        cache.put(req, res.clone());
      }
      // NO cachear XML/JSON/text error responses de WMS
    }
    return res;
  } catch (e) {
    // Offline: retornar tile transparente 1x1 para evitar errores visuales
    const bytes = Uint8Array.from(atob(EMPTY_TILE_B64), c => c.charCodeAt(0));
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
  }
}

// ── network-first (app shell) ──
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

// ── cache-first (app assets) ──
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (req.method === 'GET' && res.ok) cache.put(req, res.clone());
  return res;
}

// ── Fetch handler ──
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const host = url.hostname;

  // 1) Tiles de mapas base → cache-first desde TILE_CACHE
  if (TILE_HOSTS.some(h => host.endsWith(h))) {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  // 2) Servidores WMS → NO interceptar; dejar que el browser cargue
  //    los tiles como <img> tags normales (evita problemas CORS)
  if (WMS_HOSTS.some(h => host === h)) {
    return; // Pass-through: el browser maneja sin CORS
  }

  // 3) CDN de librerías externas (FontAwesome, Tailwind, Leaflet, etc)
  if (host.includes('cdnjs.cloudflare.com') || host.includes('cdn.tailwindcss.com') ||
      host.includes('unpkg.com') || host.includes('fonts.googleapis.com') ||
      host.includes('fonts.gstatic.com')) {
    event.respondWith(tileCacheFirst(req));
    return;
  }

  // 4) Same-origin: lógica existente
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst('./index.html'));
    return;
  }

  event.respondWith(cacheFirst(req));
});

// ── Message handler: pre-cache tiles de CR y skipWaiting ──
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE_TILES') {
    const urls = event.data.urls || [];
    event.waitUntil((async () => {
      const cache = await caches.open(TILE_CACHE);
      let cached = 0, failed = 0;
      // Procesar en lotes de 6 para no saturar la red
      for (let i = 0; i < urls.length; i += 6) {
        const batch = urls.slice(i, i + 6);
        const results = await Promise.allSettled(batch.map(async (u) => {
          const existing = await cache.match(u);
          if (existing) return;
          const res = await fetch(u);
          if (res.ok) { await cache.put(u, res); cached++; }
        }));
        results.forEach(r => { if (r.status === 'rejected') failed++; });
      }
      console.log(`[SW] Pre-cache: ${cached} nuevos, ${failed} fallidos, de ${urls.length} tiles`);
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({
        type: 'PRECACHE_DONE', cached, failed, total: urls.length
      }));
    })());
  } else if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});