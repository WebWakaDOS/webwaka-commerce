/**
 * WebWaka Commerce Suite — Service Worker v4
 * Strategy:
 *   - Shell (HTML/CSS/JS): Cache-First
 *   - SV Catalog API (/api/single-vendor/catalog, /api/single-vendor/products):
 *       Stale-While-Revalidate (serve cached immediately, refresh in background)
 *   - Product images (/api/pos/products/*/image, *.jpg, *.png, *.webp via CDN):
 *       Cache-First (POS-E20)
 *   - Other API calls: Network-First with cache fallback
 *   - Mutations: Background Sync
 * Invariants: Offline-First, PWA-First, Nigeria-First
 */
const CACHE_VERSION = 'v4';
const SHELL_CACHE = `webwaka-commerce-shell-${CACHE_VERSION}`;
const API_CACHE = `webwaka-commerce-api-${CACHE_VERSION}`;
const CATALOG_CACHE = `webwaka-commerce-catalog-${CACHE_VERSION}`;
const IMAGE_CACHE = `webwaka-commerce-images-${CACHE_VERSION}`;
const SYNC_TAG = 'webwaka-commerce-sync';

const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];

// Catalog API paths that get stale-while-revalidate treatment
const CATALOG_PATTERNS = [
  '/api/single-vendor/catalog',
  '/api/single-vendor/products',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('webwaka-commerce-') && ![SHELL_CACHE, API_CACHE, CATALOG_CACHE, IMAGE_CACHE].includes(k))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isCatalogRequest(url) {
  return CATALOG_PATTERNS.some((p) => url.pathname.startsWith(p));
}

// Product image patterns: POS product image API and common image extensions from CDNs
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|svg)(\?.*)?$/i;
function isProductImage(url) {
  return IMAGE_EXTENSIONS.test(url.pathname) || url.pathname.includes('/products/') && url.pathname.includes('/image');
}

// Cache-First for product images — serves cached asset immediately; updates cache from network
async function cacheFirstImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

  // ── Cache-First for product images (POS-E20 offline image caching) ─────────
  if (isProductImage(url)) {
    event.respondWith(cacheFirstImage(request));
    return;
  }

  // ── Stale-While-Revalidate for SV catalog/products endpoints ──────────────
  if (isCatalogRequest(url)) {
    event.respondWith(
      caches.open(CATALOG_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const fetchPromise = fetch(request)
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => cached || Response.error());
        // Serve cached immediately; refresh in background
        return cached ?? fetchPromise;
      })
    );
    return;
  }

  // ── Network-First for other API calls ─────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(API_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then((cached) => cached || Response.error()))
    );
    return;
  }

  // ── Cache-First for shell assets ──────────────────────────────────────────
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(() => {
          if (request.mode === 'navigate') return caches.match('/index.html');
        });
    })
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) =>
        clients.forEach((c) => c.postMessage({ type: 'SYNC_MUTATIONS' }))
      )
    );
  }
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'WebWaka Commerce', {
      body: data.body ?? '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: data.tag ?? 'webwaka-commerce',
    })
  );
});
