import { Hono } from 'hono';
import { getTenantId, updateWithVersionLock } from '@webwaka/core';

// Define the standard API response format (Invariant 9.2)
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  errors?: unknown[];
}

export interface SyncPayload {
  mutations: {
    id: number;
    tenantId: string;
    entityType: string;
    entityId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: unknown;
    version: number;
    timestamp: number;
  }[];
}

interface PosCheckoutItem {
  productId: string;
  quantity: number;
  newQuantity: number;
  knownVersion: number;
}

// Minimal binding interface so the sync router can access D1 without
// importing the full Env from worker.ts (avoids circular dependency).
interface SyncBindings {
  DB?: D1Database;
}

// The Sync API Router
export const syncRouter = new Hono<{ Bindings: SyncBindings }>();

// Route is public at the worker level (listed in jwtAuthMiddleware publicRoutes).
// Tenant isolation is enforced via the x-tenant-id header check below.
syncRouter.post('/sync', async (c) => {
  const tenantId = getTenantId(c);

  if (!tenantId) {
    return c.json<ApiResponse>({ success: false, errors: ['Missing X-Tenant-ID header'] }, 400);
  }

  try {
    const body = await c.req.json<SyncPayload>();
    const mutations = body.mutations;

    const results = {
      applied: [] as number[],
      conflicts: [] as unknown[],
      errors: [] as unknown[]
    };

    for (const mutation of mutations) {
      // Enforce multi-tenancy invariant
      if (mutation.tenantId !== tenantId) {
        results.errors.push({ id: mutation.id, error: 'Tenant ID mismatch' });
        continue;
      }

      // ── POS-E08: pos.checkout — lock each item's stock atomically ────────
      if (mutation.entityType === 'pos.checkout' && c.env?.DB) {
        const payload = mutation.payload as { items?: PosCheckoutItem[] };
        const items: PosCheckoutItem[] = Array.isArray(payload?.items) ? payload.items : [];
        let checkoutConflict = false;

        for (const item of items) {
          if (!item.productId) continue;

          const lockResult = await updateWithVersionLock(
            c.env.DB,
            'products',
            { quantity: item.newQuantity },
            { id: item.productId, tenantId, expectedVersion: item.knownVersion },
          );

          if (lockResult.conflict) {
            results.conflicts.push({
              id: mutation.id,
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              productId: item.productId,
              reason: 'inventory_conflict',
            });
            checkoutConflict = true;
            break;
          }
        }

        if (!checkoutConflict) {
          results.applied.push(mutation.id);
        }
        continue;
      }

      // ── Standard mutation: version-based conflict detection ───────────────
      let dbVersion = 0;
      if (c.env?.DB) {
        try {
          const row = await c.env.DB.prepare(
            `SELECT version FROM sync_versions
             WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?
             LIMIT 1`,
          )
            .bind(mutation.tenantId, mutation.entityType, mutation.entityId)
            .first<{ version: number }>();
          if (row) dbVersion = row.version;
        } catch {
          // DB unavailable or table missing — treat as new entity (version 0)
        }
      }

      if (mutation.version < dbVersion) {
        results.conflicts.push({
          id: mutation.id,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverVersion: dbVersion,
          clientVersion: mutation.version
        });
      } else {
        results.applied.push(mutation.id);

        if (c.env?.DB) {
          try {
            await c.env.DB.prepare(
              `INSERT INTO sync_versions (tenant_id, entity_type, entity_id, version, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (tenant_id, entity_type, entity_id)
               DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`,
            )
              .bind(
                mutation.tenantId,
                mutation.entityType,
                mutation.entityId,
                mutation.version,
                Date.now(),
              )
              .run();
          } catch {
            // Version tracking failure must not block the sync response
          }
        }
      }
    }

    if (results.conflicts.length > 0 || results.errors.length > 0) {
      return c.json<ApiResponse>({
        success: false,
        data: results
      }, 409);
    }

    return c.json<ApiResponse>({
      success: true,
      data: { applied: results.applied, conflicts: results.conflicts }
    });

  } catch (error) {
    return c.json<ApiResponse>({
      success: false,
      errors: [error instanceof Error ? error.message : 'Internal Server Error']
    }, 500);
  }
});

export default syncRouter;
