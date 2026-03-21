/**
 * WebWaka Commerce Suite — Service Worker v2
 * Strategy: Cache-First for shell, Network-First for API, Background Sync for mutations
 * Invariants: Offline-First, PWA-First, Nigeria-First
 */
const CACHE_VERSION = 'v2';
const SHELL_CACHE = `webwaka-commerce-shell-${CACHE_VERSION}`;
const API_CACHE = `webwaka-commerce-api-${CACHE_VERSION}`;
const SYNC_TAG = 'webwaka-commerce-sync';

const SHELL_ASSETS = ['/', '/index.html', '/manifest.json'];

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
          .filter((k) => k.startsWith('webwaka-commerce-') && k !== SHELL_CACHE && k !== API_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) return;

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
        .catch(() => caches.match(request))
    );
    return;
  }

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
