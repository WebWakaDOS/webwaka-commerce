import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';

// Define the standard API response format (Invariant 9.2)
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  errors?: any[];
}

export interface SyncPayload {
  mutations: {
    id: number;
    tenantId: string;
    entityType: string;
    entityId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    payload: any;
    version: number;
    timestamp: number;
  }[];
}

// Minimal binding interface so the sync router can access D1 without
// importing the full Env from worker.ts (avoids circular dependency).
interface SyncBindings {
  DB?: D1Database;
}

// The Sync API Router
export const syncRouter = new Hono<{ Bindings: SyncBindings }>();

syncRouter.post('/sync', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'CASHIER']), async (c) => {
  const tenantId = getTenantId(c);

  if (!tenantId) {
    return c.json<ApiResponse>({ success: false, errors: ['Missing X-Tenant-ID header'] }, 400);
  }

  try {
    const body = await c.req.json<SyncPayload>();
    const mutations = body.mutations;

    // 1. Group mutations by entity to handle them in order
    // 2. Fetch current versions from the database (D1/Postgres)
    // 3. Apply conflict resolution (e.g., optimistic concurrency)
    // 4. Apply successful mutations to the database
    // 5. Publish events to the Event Bus for successful mutations

    const results = {
      applied: [] as number[],
      conflicts: [] as any[],
      errors: [] as any[]
    };

    // Mock processing logic for the architecture plan
    for (const mutation of mutations) {
      // Enforce multi-tenancy invariant
      if (mutation.tenantId !== tenantId) {
        results.errors.push({ id: mutation.id, error: 'Tenant ID mismatch' });
        continue;
      }

      // Real conflict resolution: query D1 for the entity's current version.
      // Falls back to 0 (entity is new) when no row exists or DB is unavailable.
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
        // Conflict detected
        results.conflicts.push({
          id: mutation.id,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          serverVersion: dbVersion,
          clientVersion: mutation.version
        });
      } else {
        // Apply mutation — upsert the version in sync_versions so subsequent
        // syncs see the updated version and detect future conflicts correctly.
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
      }, 409); // 409 Conflict
    }

    return c.json<ApiResponse>({ 
      success: true, 
      data: { applied: results.applied } 
    });

  } catch (error) {
    // Zero console.log invariant - use platform logger in real implementation
    return c.json<ApiResponse>({ 
      success: false, 
      errors: [error instanceof Error ? error.message : 'Internal Server Error'] 
    }, 500);
  }
});

// Export as default for Cloudflare Workers
export default syncRouter;
