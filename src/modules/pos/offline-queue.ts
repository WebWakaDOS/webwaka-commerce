/**
 * WebWaka POS — Offline Transaction Queue
 * Specification: Implementation Plan §5 Prompt 1
 *
 * Stores PendingTransaction objects in Dexie.js (IndexedDB) when the device
 * is offline or the network call fails. A background sync worker flushes the
 * queue when connectivity is restored.
 *
 * Invariants: Offline-First, Build Once Use Infinitely, Nigeria-First
 */
import Dexie, { type Table } from 'dexie';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingTransactionItem {
  productId: string;
  productName: string;
  sku: string;
  price: number;       // kobo
  quantity: number;
  variantId?: string;
}

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'SPLIT' | 'COD' | 'AGENCY_BANKING';

export interface SplitPaymentLeg {
  method: Exclude<PaymentMethod, 'SPLIT'>;
  amount_kobo: number;
  reference?: string;
}

export interface PendingTransaction {
  id?: number;                  // auto-increment primary key
  localId: string;              // `ptx_${Date.now()}_${random}`
  tenantId: string;
  sessionId?: string;           // pos_session id at time of sale
  cashierId?: string;
  items: PendingTransactionItem[];
  totalKobo: number;
  discountKobo: number;
  taxKobo: number;
  paymentMethod: PaymentMethod;
  splitLegs?: SplitPaymentLeg[];
  customerId?: string;
  customerPhone?: string;
  customerName?: string;
  loyaltyPointsEarned: number;
  loyaltyPointsRedeemed: number;
  notes?: string;
  createdAt: number;            // epoch ms — when the cashier pressed "Complete Sale"
  syncStatus: 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED';
  syncAttempts: number;
  lastSyncError?: string;
  syncedAt?: number;
  serverOrderId?: string;       // filled in once server accepts the order
}

// ─── Dexie database ───────────────────────────────────────────────────────────

class PosOfflineQueueDB extends Dexie {
  pendingTransactions!: Table<PendingTransaction, number>;

  constructor(tenantId: string) {
    super(`WebWakaPOSQueue_${tenantId}`);
    this.version(1).stores({
      pendingTransactions:
        '++id, localId, tenantId, sessionId, cashierId, syncStatus, createdAt',
    });
  }
}

// Instance cache — one DB per tenant
const queueCache = new Map<string, PosOfflineQueueDB>();

function getQueueDB(tenantId: string): PosOfflineQueueDB {
  if (!queueCache.has(tenantId)) {
    queueCache.set(tenantId, new PosOfflineQueueDB(tenantId));
  }
  return queueCache.get(tenantId)!;
}

// ─── Queue operations ─────────────────────────────────────────────────────────

/**
 * Enqueue a transaction locally when the network is unavailable.
 * Returns the auto-generated numeric id.
 */
export async function enqueueTransaction(
  tenantId: string,
  tx: Omit<PendingTransaction, 'id' | 'syncStatus' | 'syncAttempts' | 'createdAt'>,
): Promise<number> {
  const db = getQueueDB(tenantId);
  return db.pendingTransactions.add({
    ...tx,
    tenantId,
    createdAt: Date.now(),
    syncStatus: 'PENDING',
    syncAttempts: 0,
  });
}

/** Get all transactions that have not yet been synced to the server. */
export async function getPendingTransactions(tenantId: string): Promise<PendingTransaction[]> {
  const db = getQueueDB(tenantId);
  return db.pendingTransactions
    .where({ tenantId, syncStatus: 'PENDING' })
    .sortBy('createdAt');
}

/** Count queued-but-unsynced transactions for the status badge. */
export async function getPendingTransactionCount(tenantId: string): Promise<number> {
  const db = getQueueDB(tenantId);
  return db.pendingTransactions.where({ tenantId, syncStatus: 'PENDING' }).count();
}

/** Mark a transaction as successfully synced and record the server order id. */
export async function markTransactionSynced(
  id: number,
  serverOrderId: string,
): Promise<void> {
  const dbs = [...queueCache.values()];
  for (const db of dbs) {
    const row = await db.pendingTransactions.get(id);
    if (row) {
      await db.pendingTransactions.update(id, {
        syncStatus: 'SYNCED',
        serverOrderId,
        syncedAt: Date.now(),
      });
      return;
    }
  }
}

/** Mark a transaction as failed after a sync attempt. */
export async function markTransactionFailed(
  id: number,
  error: string,
): Promise<void> {
  const dbs = [...queueCache.values()];
  for (const db of dbs) {
    const row = await db.pendingTransactions.get(id);
    if (row) {
      await db.pendingTransactions.update(id, {
        syncStatus: 'FAILED',
        lastSyncError: error,
        syncAttempts: (row.syncAttempts ?? 0) + 1,
      });
      return;
    }
  }
}

/** Reset a failed transaction back to PENDING so it can be retried. */
export async function retryFailedTransactions(tenantId: string): Promise<void> {
  const db = getQueueDB(tenantId);
  const failed = await db.pendingTransactions
    .where({ tenantId, syncStatus: 'FAILED' })
    .toArray();
  await Promise.all(
    failed.map((tx) =>
      tx.id !== undefined
        ? db.pendingTransactions.update(tx.id, { syncStatus: 'PENDING' })
        : Promise.resolve(),
    ),
  );
}

/** Delete all synced transactions older than `maxAgeMs` (default 7 days). */
export async function pruneOldSynced(
  tenantId: string,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): Promise<number> {
  const db = getQueueDB(tenantId);
  const cutoff = Date.now() - maxAgeMs;
  const old = await db.pendingTransactions
    .where('syncStatus').equals('SYNCED')
    .and((tx) => (tx.syncedAt ?? 0) < cutoff)
    .toArray();
  const ids = old.map((tx) => tx.id).filter((id): id is number => id !== undefined);
  await db.pendingTransactions.bulkDelete(ids);
  return ids.length;
}

// ─── POS Checkout helper — offline-first ─────────────────────────────────────

/**
 * Attempt to checkout via the network. If the network is unavailable or the
 * request fails, the transaction is written to the local Dexie queue instead.
 *
 * Returns `{ source: 'server', orderId }` on online success,
 * or `{ source: 'queue', localId }` when queued offline.
 */
export async function checkoutOrQueue(
  tenantId: string,
  payload: Omit<PendingTransaction, 'id' | 'syncStatus' | 'syncAttempts' | 'createdAt'>,
  apiBase = '',
  sessionToken?: string,
): Promise<{ source: 'server'; orderId: string } | { source: 'queue'; localId: string }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const id = await enqueueTransaction(tenantId, payload);
    console.info(`[POS Queue] Offline — queued transaction #${id} (${payload.localId})`);
    return { source: 'queue', localId: payload.localId };
  }

  try {
    const res = await fetch(`${apiBase}/api/pos/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-tenant-id': tenantId,
        ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      },
      body: JSON.stringify({
        items: payload.items.map((i) => ({
          product_id: i.productId,
          name: i.productName,
          quantity: i.quantity,
          price: i.price,
          variant_id: i.variantId,
        })),
        payment_method: payload.paymentMethod.toLowerCase(),
        payments: payload.splitLegs,
        customer_id: payload.customerId,
        customer_phone: payload.customerPhone,
        session_id: payload.sessionId,
        cashier_id: payload.cashierId,
        discount_kobo: payload.discountKobo,
        loyalty_points_redeemed: payload.loyaltyPointsRedeemed,
        notes: payload.notes,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const json = (await res.json()) as { success: boolean; data?: { id?: string; order_id?: string } };
    if (!json.success) throw new Error('Server rejected checkout');

    const orderId = json.data?.id ?? json.data?.order_id ?? `srv_${Date.now()}`;
    return { source: 'server', orderId };
  } catch (err) {
    console.warn('[POS Queue] Network error — queuing transaction:', err);
    const id = await enqueueTransaction(tenantId, payload);
    console.info(`[POS Queue] Queued transaction #${id} (${payload.localId})`);
    return { source: 'queue', localId: payload.localId };
  }
}

// ─── Background sync worker ───────────────────────────────────────────────────

export interface SyncResult {
  flushed: number;
  failed: number;
  errors: string[];
}

/**
 * Flush all PENDING transactions in the queue to the server.
 * Designed to be called from:
 *   - The `online` event listener
 *   - A periodic interval (every 30 s)
 *   - The service worker background sync event
 *
 * Processes one transaction at a time (sequential) to avoid overwhelming a
 * recovering network.
 */
export async function flushTransactionQueue(
  tenantId: string,
  apiBase = '',
  sessionToken?: string,
): Promise<SyncResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { flushed: 0, failed: 0, errors: [] };
  }

  const pending = await getPendingTransactions(tenantId);
  let flushed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const tx of pending) {
    if (tx.id === undefined) continue;
    try {
      const res = await fetch(`${apiBase}/api/pos/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
        },
        body: JSON.stringify({
          items: tx.items.map((i) => ({
            product_id: i.productId,
            name: i.productName,
            quantity: i.quantity,
            price: i.price,
            variant_id: i.variantId,
          })),
          payment_method: tx.paymentMethod.toLowerCase(),
          payments: tx.splitLegs,
          customer_id: tx.customerId,
          customer_phone: tx.customerPhone,
          session_id: tx.sessionId,
          cashier_id: tx.cashierId,
          discount_kobo: tx.discountKobo,
          loyalty_points_redeemed: tx.loyaltyPointsRedeemed,
          notes: tx.notes,
          offline_local_id: tx.localId,
          offline_created_at: tx.createdAt,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = (await res.json()) as { success: boolean; data?: { id?: string; order_id?: string } };
      if (!json.success) throw new Error('Server rejected');

      const orderId = json.data?.id ?? json.data?.order_id ?? `srv_${Date.now()}`;
      await markTransactionSynced(tx.id, orderId);
      flushed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markTransactionFailed(tx.id, msg);
      errors.push(`[${tx.localId}] ${msg}`);
      failed++;
    }
  }

  if (flushed > 0) {
    console.info(`[POS Queue] Flushed ${flushed} offline transaction(s) to server.`);
  }

  return { flushed, failed, errors };
}

// ─── React hook — useOfflineQueue ─────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';

export interface UseOfflineQueueResult {
  pendingCount: number;
  flush: () => Promise<SyncResult>;
  lastFlushResult: SyncResult | null;
}

/**
 * React hook that:
 *  1. Polls the local Dexie queue every 5 s to display the pending count
 *  2. Automatically flushes the queue when the browser comes back online
 *  3. Exposes a `flush()` function for manual triggering
 */
export function useOfflineQueue(
  tenantId: string,
  apiBase = '',
  sessionToken?: string,
): UseOfflineQueueResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [lastFlushResult, setLastFlushResult] = useState<SyncResult | null>(null);

  // Poll count every 5 s
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const count = await getPendingTransactionCount(tenantId);
        if (!cancelled) setPendingCount(count);
      } catch { /* IndexedDB unavailable — ignore */ }
    };
    void poll();
    const interval = setInterval(poll, 5_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tenantId]);

  const flush = useCallback(async (): Promise<SyncResult> => {
    const result = await flushTransactionQueue(tenantId, apiBase, sessionToken);
    setLastFlushResult(result);
    try {
      const count = await getPendingTransactionCount(tenantId);
      setPendingCount(count);
    } catch { /* no-op */ }
    return result;
  }, [tenantId, apiBase, sessionToken]);

  // Flush automatically when coming back online
  useEffect(() => {
    const onOnline = () => { void flush(); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [flush]);

  return { pendingCount, flush, lastFlushResult };
}
