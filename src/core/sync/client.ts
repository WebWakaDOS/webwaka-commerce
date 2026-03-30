/**
 * WebWaka Commerce Suite — Offline Sync Client (P0-T02)
 *
 * Architecture:
 * - SyncClient: primary class — accepts CommerceOfflineDB via DI (no orphaned DB).
 * - SyncManager: backward-compat wrapper used by pos/core.ts — constructs SyncClient
 *   using getCommerceDB(tenantId). Only ONE IndexedDB (`WebWakaCommerce_*`) is opened.
 *
 * Fixed: previously instantiated a separate `WebWakaDB_*` Dexie v1 DB that
 * silently disconnected mutations from the main `WebWakaCommerce_*` v6 DB.
 */

import type { CommerceOfflineDB, SyncConflict } from '../offline/db';
import { getCommerceDB } from '../offline/db';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface SyncError {
  id: number;
  entityType: string;
  entityId: string;
  error: string;
}

interface SyncApiResponse {
  success: boolean;
  data?: {
    applied: number[];
    conflicts?: Array<{
      id: number;
      entityType: string;
      entityId: string;
      serverVersion: number;
      clientVersion: number;
    }>;
    errors?: SyncError[];
  };
  errors?: string[];
}

// ─── SyncClient — primary class with dependency injection ─────────────────────

export class SyncClient {
  private isOnline: boolean;

  constructor(
    private db: CommerceOfflineDB,
    private tenantId: string,
    private syncApiUrl: string,
  ) {
    // `navigator` is only available in browser contexts.
    this.isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;

    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.isOnline = true;
        void this.processQueue();
      });
      window.addEventListener('offline', () => {
        this.isOnline = false;
      });
    }
  }

  // ── Queue a mutation for deferred sync ──────────────────────────────────────
  async queueMutation(
    entityType: string,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: unknown,
    version: number,
  ): Promise<void> {
    await this.db.mutations.add({
      tenantId: this.tenantId,
      entityType: entityType as 'order' | 'product' | 'cart' | 'vendor',
      entityId,
      action,
      payload,
      version,
      timestamp: Date.now(),
      status: 'PENDING',
      retryCount: 0,
    });

    if (this.isOnline) {
      void this.processQueue();
    }
  }

  // ── Flush pending mutations to server ───────────────────────────────────────
  async processQueue(): Promise<void> {
    if (!this.isOnline) return;

    const pendingMutations = await this.db.mutations
      .where('status')
      .anyOf(['PENDING', 'FAILED'])
      .toArray();

    if (pendingMutations.length === 0) return;

    try {
      const response = await fetch(this.syncApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tenant-ID': this.tenantId,
        },
        body: JSON.stringify({ mutations: pendingMutations }),
      });

      // Narrow the unknown json() response with a type assertion + runtime check
      const raw: unknown = await response.json();
      const result = raw as SyncApiResponse;

      if (result.success === true) {
        const appliedIds = pendingMutations
          .filter((m) => m.id !== undefined)
          .map((m) => m.id as number);
        await this.db.mutations.bulkDelete(appliedIds);
      } else {
        // Map server errors to SyncError[] for handleSyncErrors
        const serverErrors: SyncError[] = (result.data?.errors ?? []).map((e) => ({
          id: e.id,
          entityType: e.entityType,
          entityId: e.entityId,
          error: e.error,
        }));
        const conflictErrors: SyncError[] = (result.data?.conflicts ?? []).map((c) => ({
          id: c.id,
          entityType: c.entityType,
          entityId: c.entityId,
          error: `Version mismatch: server=${c.serverVersion}, client=${c.clientVersion}`,
        }));
        await this.handleSyncErrors([...serverErrors, ...conflictErrors]);

        // Increment retry count for all pending mutations
        for (const mutation of pendingMutations) {
          if (mutation.id !== undefined) {
            await this.db.mutations.update(mutation.id, {
              status: 'FAILED',
              retryCount: mutation.retryCount + 1,
            });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      // Emit warn (not error) per CF Workers logs policy
      console.warn('Sync processQueue failed:', message);

      // Record as network_error conflict + increment retry count
      const networkErrors: SyncError[] = pendingMutations.map((m) => ({
        id: m.id ?? 0,
        entityType: m.entityType,
        entityId: m.entityId,
        error: message,
      }));
      await this.handleSyncErrors(networkErrors, 'network_error');

      for (const mutation of pendingMutations) {
        if (mutation.id !== undefined) {
          await this.db.mutations.update(mutation.id, {
            status: 'FAILED',
            retryCount: mutation.retryCount + 1,
            error: message,
          });
        }
      }
    }
  }

  // ── Record sync errors in IndexedDB syncConflicts table ─────────────────────
  // Never throws — sync errors must be recoverable [MPO].
  async handleSyncErrors(
    errors: SyncError[],
    overrideConflictType?: SyncConflict['conflictType'],
  ): Promise<void> {
    try {
      const now = Date.now();
      const conflicts: SyncConflict[] = errors.map((e) => {
        let conflictType: SyncConflict['conflictType'];
        if (overrideConflictType) {
          conflictType = overrideConflictType;
        } else if (e.error.includes('Version mismatch')) {
          conflictType = 'version_mismatch';
        } else {
          conflictType = 'server_reject';
        }

        return {
          id: `conflict_${now}_${e.id}_${e.entityId}`,
          tenantId: this.tenantId,
          entityType: e.entityType,
          entityId: e.entityId,
          conflictType,
          serverMessage: e.error,
          localPayload: {},
          occurredAt: now,
        };
      });

      await this.db.syncConflicts.bulkAdd(conflicts);
      console.warn(
        `[SyncClient] ${conflicts.length} sync conflict(s) recorded for tenant ${this.tenantId}:`,
        conflicts.map((c) => `${c.entityType}/${c.entityId} (${c.conflictType})`).join(', '),
      );
    } catch {
      // Swallow — do not let conflict logging crash the sync loop
    }
  }
}

// ─── SyncManager — backward-compat wrapper ────────────────────────────────────
// Used by: src/modules/pos/core.ts
// Opens ONLY the canonical `WebWakaCommerce_*` DB (via getCommerceDB) — no orphaned DB.

export class SyncManager {
  private client: SyncClient;

  constructor(tenantId: string, syncApiUrl: string) {
    const db = getCommerceDB(tenantId);
    this.client = new SyncClient(db, tenantId, syncApiUrl);
  }

  async queueMutation(
    entityType: string,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    payload: unknown,
    version: number,
  ): Promise<void> {
    return this.client.queueMutation(entityType, entityId, action, payload, version);
  }

  async processQueue(): Promise<void> {
    return this.client.processQueue();
  }
}
