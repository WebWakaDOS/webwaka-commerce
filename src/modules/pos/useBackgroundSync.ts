/**
 * useBackgroundSync — flushes pending Dexie mutations to the server (Phase 2)
 * Triggers on component mount (if online) and on every `online` event.
 * Uses the existing POST /api/pos/sync endpoint (idempotent).
 * After a successful flush, seeds the local product cache via syncProductCache.
 */
import { useEffect, useCallback, useRef } from 'react';

interface SyncResult {
  applied: string[];
  skipped: string[];
  failed: string[];
  synced_at: number;
}

/**
 * Fetch all POS cmrc_products from the server and upsert them into the Dexie
 * 'cmrc_products' table so offline reads are always backed by fresh data.
 */
async function syncProductCache(tenantId: string): Promise<void> {
  try {
    const res = await fetch('/api/pos/cmrc_products', {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!res.ok) return;

    const json = (await res.json()) as { success: boolean; data: unknown[] };
    if (!json.success || !Array.isArray(json.data)) return;

    const { getCommerceDB } = await import('../../core/offline/db');
    const db = getCommerceDB(tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.table('cmrc_products').bulkPut(json.data as any[]);
  } catch {
    // Network or DB error — non-fatal; will retry on next sync cycle
  }
}

async function flushPendingMutations(tenantId: string): Promise<SyncResult | null> {
  try {
    // Lazy import so this hook is safe in non-IndexedDB environments
    const { getCommerceDB } = await import('../../core/offline/db');
    const db = getCommerceDB(tenantId);
    const pending = await db.mutations.where({ tenantId, status: 'PENDING' }).toArray();

    if (pending.length === 0) return null;

    const res = await fetch('/api/pos/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
      body: JSON.stringify({
        mutations: pending.map((m) => ({
          entity_type: m.entityType,
          entity_id: m.entityId,
          action: m.action,
          payload: m.payload,
          version: m.version,
        })),
      }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { success: boolean; data: SyncResult };
    if (!data.success) return null;

    // Mark successfully applied mutations as SYNCED
    for (const m of pending) {
      if (m.id !== undefined && data.data.applied.some((id) => id === m.entityId)) {
        await db.mutations.update(m.id, { status: 'SYNCED' });
      } else if (m.id !== undefined && data.data.failed.some((id) => id === m.entityId)) {
        await db.mutations.update(m.id, { status: 'FAILED', retryCount: (m.retryCount ?? 0) + 1 });
      }
    }

    return data.data;
  } catch {
    return null;
  }
}

/**
 * Fetch top 200 POS cmrc_customers from the server (ordered by lastPurchaseAt)
 * and upsert them into the Dexie 'cmrc_customers' table so the POS can do
 * instant phone/name lookups even when offline.
 * Called after every successful mutation flush.
 */
export async function syncCustomerCache(tenantId: string): Promise<void> {
  try {
    const res = await fetch('/api/pos/cmrc_customers/top', {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!res.ok) return;

    const json = (await res.json()) as { success: boolean; cmrc_customers: unknown[] };
    if (!json.success || !Array.isArray(json.cmrc_customers)) return;

    const { getCommerceDB } = await import('../../core/offline/db');
    const db = getCommerceDB(tenantId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.table('cmrc_customers').bulkPut(json.cmrc_customers as any[]);
  } catch {
    // Network or DB error — non-fatal; will retry on next sync cycle
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useBackgroundSync(
  tenantId: string,
  onSynced?: (result: SyncResult) => void,
) {
  // Prevent overlapping sync calls
  const syncInProgress = useRef(false);

  const sync = useCallback(async () => {
    if (syncInProgress.current) return;
    syncInProgress.current = true;
    try {
      const result = await flushPendingMutations(tenantId);
      if (result && result.applied.length > 0) {
        onSynced?.(result);
        // Seed product and customer caches after a successful flush so the POS
        // is ready to serve cmrc_customers even when they go offline afterward.
        await syncProductCache(tenantId);
        await syncCustomerCache(tenantId);
      }
    } finally {
      syncInProgress.current = false;
    }
  }, [tenantId, onSynced]);

  useEffect(() => {
    // Flush on mount if online
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      sync();
    }

    const handleOnline = () => sync();
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [sync]);

  return { flush: sync };
}
