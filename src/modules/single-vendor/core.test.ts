import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorefrontCore, StorefrontCartItem } from './core';
import { eventBus } from '../../core/event-bus';

describe('Single Vendor Storefront Core', () => {
  let storefrontCore: StorefrontCore;

  beforeEach(() => {
    storefrontCore = new StorefrontCore('tnt_123');
    vi.clearAllMocks();
  });

  it('should process checkout, mock payment, and publish events', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('order.created', mockHandler);
    eventBus.subscribe('inventory.updated', mockHandler);
    eventBus.subscribe('payment.completed', mockHandler);

    const cart: StorefrontCartItem[] = [
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

    const order = await storefrontCore.checkout(cart, 'customer@example.com');

    expect(order.totalAmount).toBe(20000); // 2 * 10000
    expect(order.status).toBe('PAID');
    expect(order.customerId).toBe('customer@example.com');
    expect(order.paymentReference).toBeDefined();
    expect(order.paymentReference).toContain('pay_');

    // Wait for async event publishing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have published 3 events: inventory.updated, order.created, payment.completed
    expect(mockHandler).toHaveBeenCalledTimes(3);
  });
});
