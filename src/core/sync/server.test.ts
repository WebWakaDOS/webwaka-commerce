import { describe, it, expect } from 'vitest';
import { syncRouter } from './server';
import type { ApiResponse } from './server';

interface SyncResult {
  applied?: number[];
  conflicts?: Array<{ id: number; error?: string }>;
  errors?: Array<{ id: number; error: string }>;
}

// ── Mock D1 database ──────────────────────────────────────────────────────────
// Returns version 1 for entity_id 'item_2' (used to test conflict detection),
// and no row (null) for all other entities.
const mockDb = {
  prepare: (sql: string) => ({
    bind: (..._args: unknown[]) => ({
      first: async <T>(): Promise<T | null> => {
        // Only return a version row for item_2 so conflict detection is testable
        if (sql.includes('sync_versions') && sql.includes('SELECT version')) {
          const entityId = _args[2] as string;
          if (entityId === 'item_2') return { version: 1 } as T;
        }
        return null;
      },
      run: async () => ({ success: true, meta: { changes: 1 } }),
    }),
  }),
};

const mockEnv = { DB: mockDb };

describe('Universal Offline Sync Engine - Server API', () => {
  it('should reject requests without X-Tenant-ID header', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mutations: [] }),
    });

    const res = await syncRouter.fetch(req);
    expect(res.status).toBe(400);

    const data = await res.json() as ApiResponse;
    expect(data.success).toBe(false);
    expect(data.errors).toContain('Missing X-Tenant-ID header');
  });

  it('should process valid mutations successfully', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 1,
            tenantId: 'tnt_123',
            entityType: 'inventory',
            entityId: 'item_1',  // No existing version in mock → dbVersion=0
            action: 'UPDATE',
            payload: { quantity: 10 },
            version: 2,          // 2 >= 0 → accepted
            timestamp: Date.now(),
          },
        ],
      }),
    });

    const res = await syncRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);

    const data = await res.json() as ApiResponse<SyncResult>;
    expect(data.success).toBe(true);
    expect(data.data?.applied).toContain(1);
  });

  it('should detect conflicts based on version numbers', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 2,
            tenantId: 'tnt_123',
            entityType: 'inventory',
            entityId: 'item_2',  // Mock DB returns version=1 for item_2
            action: 'UPDATE',
            payload: { quantity: 5 },
            version: 0,          // 0 < 1 → conflict
            timestamp: Date.now(),
          },
        ],
      }),
    });

    const res = await syncRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(409);

    const data = await res.json() as ApiResponse<SyncResult>;
    expect(data.success).toBe(false);
    expect(data.data?.conflicts?.length).toBe(1);
    expect(data.data?.conflicts?.[0]?.id).toBe(2);
  });

  it('should enforce multi-tenant isolation', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123',
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 3,
            tenantId: 'tnt_456',  // Mismatched tenant → error
            entityType: 'inventory',
            entityId: 'item_3',
            action: 'UPDATE',
            payload: { quantity: 15 },
            version: 2,
            timestamp: Date.now(),
          },
        ],
      }),
    });

    const res = await syncRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(409);

    const data = await res.json() as ApiResponse<SyncResult>;
    expect(data.success).toBe(false);
    expect(data.data?.errors?.[0]?.error).toBe('Tenant ID mismatch');
  });
});
