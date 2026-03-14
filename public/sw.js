const CACHE_NAME = 'webwaka-commerce-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  // In a real build, we would inject the bundled JS/CSS here
];

// Install event: Cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate event: Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Fetch event: Network first, fallback to cache (Offline First Invariant)
self.addEventListener('fetch', (event) => {
  // Skip cross-origin requests
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // For API requests (like /sync), we don't cache them here.
  // The Dexie Mutation Queue handles offline data sync.
  if (event.request.url.includes('/sync') || event.request.url.includes('/publish')) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

// Background Sync event (for the Mutation Queue)
self.addEventListener('sync', (event) => {
  if (event.tag === 'webwaka-sync') {
    event.waitUntil(
      // In a real implementation, this would trigger the SyncManager to process the queue
      console.log('Background sync triggered')
    );
  }
});
