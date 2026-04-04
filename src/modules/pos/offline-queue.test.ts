/**
 * QA-COM-1 — Offline POS Queue Unit Tests
 *
 * Certifies: "The POS successfully records transactions to Dexie.js when
 * offline and syncs them to D1 when online."
 *
 * Dexie requires IndexedDB which is not available in the node test
 * environment, so the entire Dexie module is mocked with a minimal
 * in-memory implementation that mimics the PosOfflineQueueDB schema.
 *
 * Also satisfies QA-COM-4 (unit tests for new POS modules).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── In-memory Dexie mock ─────────────────────────────────────────────────────
//
// We replicate just the Table API surface used by offline-queue.ts:
//   table.add, table.get, table.update, table.bulkDelete,
//   table.where({ col: val }).count(), .sortBy(), .toArray(), .equals().and().toArray()

type Row = Record<string, unknown> & { id?: number };

class MockTable {
  private rows: Row[] = [];
  private seq = 0;

  async add(obj: Row): Promise<number> {
    const id = ++this.seq;
    this.rows.push({ ...obj, id });
    return id;
  }

  async get(id: number): Promise<Row | undefined> {
    return this.rows.find((r) => r.id === id);
  }

  async update(id: number, changes: Partial<Row>): Promise<number> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx === -1) return 0;
    this.rows[idx] = { ...this.rows[idx], ...changes };
    return 1;
  }

  async bulkDelete(ids: number[]): Promise<void> {
    this.rows = this.rows.filter((r) => !ids.includes(r.id as number));
  }

  where(filter: Record<string, unknown> | string) {
    // Dexie supports both .where({ k: v }) and .where('fieldName')
    const isString = typeof filter === 'string';
    const filterField = isString ? filter : null;
    const filterObj = isString ? null : filter as Record<string, unknown>;

    const baseMatches = () =>
      this.rows.filter((r) =>
        filterObj
          ? Object.entries(filterObj).every(([k, v]) => r[k] === v)
          : true, // string form — no filter applied until .equals()
      );

    return {
      count: async () => baseMatches().length,
      sortBy: async (field: string) =>
        [...baseMatches()].sort((a, b) => (a[field] as number) - (b[field] as number)),
      toArray: async () => baseMatches(),
      equals: (val: unknown) => {
        // .where('fieldName').equals(val).and(pred).toArray()
        const field = filterField ?? (filterObj ? Object.keys(filterObj)[0] : '') ?? '';
        const equalsMatches = () => this.rows.filter((r) => r[field] === val);
        return {
          and: (predFn: (row: Row) => boolean) => ({
            toArray: async () => equalsMatches().filter(predFn),
          }),
        };
      },
    };
  }

  // Expose internal rows for test assertions
  _rows() { return this.rows; }
  _reset() { this.rows = []; this.seq = 0; }
}

const mockTable = new MockTable();

vi.mock('dexie', () => {
  class MockDexie {
    version(_v: number) {
      return {
        stores: (_schema: unknown) => {
          // `declare field` emits no JS, so we must assign here after super() runs
          (this as Record<string, unknown>)['pendingTransactions'] = mockTable;
          return this;
        },
      };
    }
  }
  return { default: MockDexie, Table: class {} };
});

// ─── Import module AFTER mock is registered ───────────────────────────────────

import {
  enqueueTransaction,
  getPendingTransactions,
  getPendingTransactionCount,
  markTransactionSynced,
  markTransactionFailed,
  retryFailedTransactions,
  pruneOldSynced,
  checkoutOrQueue,
  flushTransactionQueue,
  type PendingTransaction,
} from './offline-queue';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT = 'tnt_qa';

const baseTx = (): Omit<PendingTransaction, 'id' | 'syncStatus' | 'syncAttempts' | 'createdAt'> => ({
  localId: `ptx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  tenantId: TENANT,
  sessionId: 'sess_001',
  cashierId: 'cashier_001',
  items: [
    {
      productId: 'prod_rice',
      productName: 'Jollof Rice',
      sku: 'JR-001',
      price: 250_000,
      quantity: 2,
    },
  ],
  totalKobo: 500_000,
  discountKobo: 0,
  taxKobo: 0,
  paymentMethod: 'CASH',
  loyaltyPointsEarned: 50,
  loyaltyPointsRedeemed: 0,
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockTable._reset();
  vi.restoreAllMocks();
  // Default: browser is "online"
  Object.defineProperty(global, 'navigator', {
    value: { onLine: true },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── QA-COM-1: Offline transaction recording ──────────────────────────────────

describe('QA-COM-1 — Offline Transaction Recording', () => {
  it('enqueueTransaction stores a PENDING transaction in Dexie', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    expect(id).toBeGreaterThan(0);
    const rows = mockTable._rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.syncStatus).toBe('PENDING');
    expect(rows[0]!.syncAttempts).toBe(0);
    expect(rows[0]!.tenantId).toBe(TENANT);
  });

  it('checkoutOrQueue queues transaction to Dexie when navigator.onLine is false', async () => {
    Object.defineProperty(global, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const tx = baseTx();
    const result = await checkoutOrQueue(TENANT, tx);

    expect(result.source).toBe('queue');
    expect((result as { source: 'queue'; localId: string }).localId).toBe(tx.localId);
    expect(mockTable._rows()).toHaveLength(1);
    expect(mockTable._rows()[0]!.syncStatus).toBe('PENDING');
  });

  it('checkoutOrQueue queues transaction when fetch throws (network error)', async () => {
    // navigator.onLine = true but fetch fails — simulates flaky connection
    global.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const tx = baseTx();
    const result = await checkoutOrQueue(TENANT, tx, 'http://localhost');

    expect(result.source).toBe('queue');
    expect(mockTable._rows()).toHaveLength(1);
  });

  it('checkoutOrQueue returns server source on successful fetch', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: 'srv_order_001' } }),
    });

    const result = await checkoutOrQueue(TENANT, baseTx(), 'http://localhost');
    expect(result.source).toBe('server');
    expect((result as { source: 'server'; orderId: string }).orderId).toBe('srv_order_001');
    expect(mockTable._rows()).toHaveLength(0); // nothing was queued
  });

  it('checkoutOrQueue queues when server returns HTTP 503', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await checkoutOrQueue(TENANT, baseTx(), 'http://localhost');
    expect(result.source).toBe('queue');
  });
});

// ─── getPendingTransactions / getPendingTransactionCount ──────────────────────

describe('QA-COM-1 — Pending transaction retrieval', () => {
  it('getPendingTransactions returns only PENDING rows', async () => {
    await enqueueTransaction(TENANT, baseTx());
    await enqueueTransaction(TENANT, baseTx());
    const pending = await getPendingTransactions(TENANT);
    expect(pending).toHaveLength(2);
    expect(pending.every((t) => t.syncStatus === 'PENDING')).toBe(true);
  });

  it('getPendingTransactionCount reflects queue size', async () => {
    expect(await getPendingTransactionCount(TENANT)).toBe(0);
    await enqueueTransaction(TENANT, baseTx());
    expect(await getPendingTransactionCount(TENANT)).toBe(1);
    await enqueueTransaction(TENANT, baseTx());
    expect(await getPendingTransactionCount(TENANT)).toBe(2);
  });
});

// ─── markTransactionSynced — sync confirmation ────────────────────────────────

describe('QA-COM-1 — Sync confirmation (markTransactionSynced)', () => {
  it('marks a PENDING transaction as SYNCED with a server order id', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionSynced(id, 'srv_order_abc');

    const row = mockTable._rows().find((r) => r.id === id)!;
    expect(row.syncStatus).toBe('SYNCED');
    expect(row.serverOrderId).toBe('srv_order_abc');
    expect(row.syncedAt).toBeGreaterThan(0);
  });

  it('SYNCED transaction is excluded from getPendingTransactions', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionSynced(id, 'srv_order_xyz');

    const pending = await getPendingTransactions(TENANT);
    expect(pending.find((t) => t.id === id)).toBeUndefined();
  });

  it('getPendingTransactionCount drops to 0 after all synced', async () => {
    const id1 = await enqueueTransaction(TENANT, baseTx());
    const id2 = await enqueueTransaction(TENANT, baseTx());
    await markTransactionSynced(id1, 'srv_1');
    await markTransactionSynced(id2, 'srv_2');
    expect(await getPendingTransactionCount(TENANT)).toBe(0);
  });
});

// ─── markTransactionFailed + retryFailedTransactions ─────────────────────────

describe('QA-COM-1 — Failure handling and retry', () => {
  it('markTransactionFailed sets FAILED status and increments syncAttempts', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionFailed(id, 'Timeout');

    const row = mockTable._rows().find((r) => r.id === id)!;
    expect(row.syncStatus).toBe('FAILED');
    expect(row.lastSyncError).toBe('Timeout');
    expect(row.syncAttempts).toBe(1);
  });

  it('retryFailedTransactions resets FAILED → PENDING', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionFailed(id, 'HTTP 500');
    await retryFailedTransactions(TENANT);

    const row = mockTable._rows().find((r) => r.id === id)!;
    expect(row.syncStatus).toBe('PENDING');
  });

  it('FAILED transactions do NOT appear in getPendingTransactions', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionFailed(id, 'Error');
    const pending = await getPendingTransactions(TENANT);
    expect(pending.find((t) => t.id === id)).toBeUndefined();
  });
});

// ─── flushTransactionQueue — online re-sync ───────────────────────────────────

describe('QA-COM-1 — flushTransactionQueue (online sync)', () => {
  it('flushes PENDING transactions to server and marks them SYNCED', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { id: `srv_${Date.now()}` } }),
    });

    await enqueueTransaction(TENANT, baseTx());
    await enqueueTransaction(TENANT, baseTx());

    const result = await flushTransactionQueue(TENANT, 'http://localhost');

    expect(result.flushed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const pending = await getPendingTransactions(TENANT);
    expect(pending).toHaveLength(0); // all cleared
  });

  it('tracks partial failure correctly', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: { id: 'srv_ok' } }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await enqueueTransaction(TENANT, baseTx());
    await enqueueTransaction(TENANT, baseTx());

    const result = await flushTransactionQueue(TENANT, 'http://localhost');
    expect(result.flushed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it('does not flush when navigator.onLine is false', async () => {
    Object.defineProperty(global, 'navigator', {
      value: { onLine: false },
      configurable: true,
      writable: true,
    });

    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    await enqueueTransaction(TENANT, baseTx());
    const result = await flushTransactionQueue(TENANT, 'http://localhost');

    expect(result.flushed).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── pruneOldSynced ───────────────────────────────────────────────────────────

describe('pruneOldSynced', () => {
  it('deletes SYNCED records older than maxAgeMs', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionSynced(id, 'srv_old');
    // Backdate the syncedAt timestamp by 8 days
    const row = mockTable._rows().find((r) => r.id === id)!;
    row.syncedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const pruned = await pruneOldSynced(TENANT, 7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(1);
    expect(mockTable._rows()).toHaveLength(0);
  });

  it('keeps SYNCED records within maxAgeMs', async () => {
    const id = await enqueueTransaction(TENANT, baseTx());
    await markTransactionSynced(id, 'srv_recent');

    const pruned = await pruneOldSynced(TENANT, 7 * 24 * 60 * 60 * 1000);
    expect(pruned).toBe(0);
    expect(mockTable._rows()).toHaveLength(1);
  });
});
