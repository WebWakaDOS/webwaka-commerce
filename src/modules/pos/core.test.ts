import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POSCore, CartItem } from './core';
import { eventBus } from '../../core/event-bus';

// Mock the SyncManager
vi.mock('../../core/sync/client', () => {
  return {
    SyncManager: class {
      queueMutation = vi.fn().mockResolvedValue(undefined);
    }
  };
});

describe('POS Module Core', () => {
  let posCore: POSCore;

  beforeEach(() => {
    posCore = new POSCore('tnt_123', 'http://localhost/sync');
    vi.clearAllMocks();
  });

  it('should process checkout and publish events', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('order.created', mockHandler);
    eventBus.subscribe('inventory.updated', mockHandler);
    eventBus.subscribe('payment.completed', mockHandler);

    const cart: CartItem[] = [
      {
        id: 'item_1',
        tenantId: 'tnt_123',
        sku: 'SKU-001',
        name: 'Test Product',
        quantity: 10,
        price: 10000, // 100 NGN
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        cartQuantity: 2
      }
    ];

    const order = await posCore.checkout(cart, 'CASH');

    expect(order.totalAmount).toBe(20000); // 2 * 10000
    expect(order.status).toBe('COMPLETED');
    expect(order.paymentMethod).toBe('CASH');

    // Wait for async event publishing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have published 3 events: inventory.updated, order.created, payment.completed
    expect(mockHandler).toHaveBeenCalledTimes(3);
  });
});
