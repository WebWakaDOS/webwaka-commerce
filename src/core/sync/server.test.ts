import { describe, it, expect } from 'vitest';
import { syncRouter } from './server';

describe('Universal Offline Sync Engine - Server API', () => {
  it('should reject requests without X-Tenant-ID header', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ mutations: [] })
    });

    const res = await syncRouter.fetch(req);
    expect(res.status).toBe(400);
    
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.errors).toContain('Missing X-Tenant-ID header');
  });

  it('should process valid mutations successfully', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123'
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 1,
            tenantId: 'tnt_123',
            entityType: 'inventory',
            entityId: 'item_1',
            action: 'UPDATE',
            payload: { quantity: 10 },
            version: 2, // Higher than mock DB version (1)
            timestamp: Date.now()
          }
        ]
      })
    });

    const res = await syncRouter.fetch(req);
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.data.applied).toContain(1);
  });

  it('should detect conflicts based on version numbers', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123'
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 2,
            tenantId: 'tnt_123',
            entityType: 'inventory',
            entityId: 'item_2',
            action: 'UPDATE',
            payload: { quantity: 5 },
            version: 0, // Lower than mock DB version (1)
            timestamp: Date.now()
          }
        ]
      })
    });

    const res = await syncRouter.fetch(req);
    expect(res.status).toBe(409); // Conflict
    
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.data.conflicts.length).toBe(1);
    expect(data.data.conflicts[0].id).toBe(2);
  });

  it('should enforce multi-tenant isolation', async () => {
    const req = new Request('http://localhost/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123'
      },
      body: JSON.stringify({
        mutations: [
          {
            id: 3,
            tenantId: 'tnt_456', // Mismatch with header
            entityType: 'inventory',
            entityId: 'item_3',
            action: 'UPDATE',
            payload: { quantity: 15 },
            version: 2,
            timestamp: Date.now()
          }
        ]
      })
    });

    const res = await syncRouter.fetch(req);
    expect(res.status).toBe(409);
    
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.data.errors[0].error).toBe('Tenant ID mismatch');
  });
});
