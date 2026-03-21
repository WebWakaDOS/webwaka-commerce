/**
 * WebWaka Commerce Suite — PWA Entry Point
 * Registers service worker, handles sync messages, mounts React app
 * Invariants: PWA-First, Offline-First
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommerceApp } from './app';

// ─── Service Worker Registration ─────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        console.info('[SW] Registered:', registration.scope);

        // Listen for sync messages from the service worker
        navigator.serviceWorker.addEventListener('message', async (event) => {
          if (event.data?.type === 'SYNC_MUTATIONS') {
            // Dynamic import to avoid circular deps
            const { getPendingMutations, markMutationSynced } = await import('./core/offline/db');
            const pending = await getPendingMutations('tnt_demo');
            for (const mutation of pending) {
              try {
                const res = await fetch(`/api/${mutation.entityType}/sync`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-tenant-id': mutation.tenantId,
                  },
                  body: JSON.stringify(mutation.payload),
                });
                if (res.ok && mutation.id !== undefined) {
                  await markMutationSynced(mutation.id);
                }
              } catch {
                // Will retry on next sync
              }
            }
          }
        });
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  });
}

// ─── Mount React App ─────────────────────────────────────────────────────────
const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <CommerceApp />
  </React.StrictMode>
);
