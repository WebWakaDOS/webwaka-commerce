import { describe, it, expect, vi } from 'vitest';
import { eventBus, eventBusRouter, WebWakaEvent } from './index';

describe('Platform Event Bus', () => {
  it('should allow subscribing and publishing events', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('inventory.updated', mockHandler);

    const event: WebWakaEvent = {
      id: 'evt_1',
      tenantId: 'tnt_123',
      type: 'inventory.updated',
      sourceModule: 'pos',
      timestamp: Date.now(),
      payload: { itemId: 'item_1', quantity: 10 }
    };

    await eventBus.publish(event);

    expect(mockHandler).toHaveBeenCalledTimes(1);
    expect(mockHandler).toHaveBeenCalledWith(event);
  });

  it('should reject API requests without X-Tenant-ID header', async () => {
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(400);
  });

  it('should enforce multi-tenant isolation on API requests', async () => {
    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123'
      },
      body: JSON.stringify({
        id: 'evt_2',
        tenantId: 'tnt_456', // Mismatch
        type: 'order.created',
        sourceModule: 'pos',
        timestamp: Date.now(),
        payload: {}
      })
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(403);
  });

  it('should publish valid events via API', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('order.created', mockHandler);

    const req = new Request('http://localhost/publish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': 'tnt_123'
      },
      body: JSON.stringify({
        id: 'evt_3',
        tenantId: 'tnt_123',
        type: 'order.created',
        sourceModule: 'pos',
        timestamp: Date.now(),
        payload: { orderId: 'ord_1' }
      })
    });

    const res = await eventBusRouter.fetch(req);
    expect(res.status).toBe(200);
    
    // Wait a tick for async publish to complete
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });
});
