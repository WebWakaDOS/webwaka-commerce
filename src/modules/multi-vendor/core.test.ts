import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketplaceCore, MarketplaceCartItem } from './core';
import { eventBus } from '../../core/event-bus';

describe('Multi Vendor Marketplace Core', () => {
  let marketplaceCore: MarketplaceCore;

  beforeEach(() => {
    marketplaceCore = new MarketplaceCore('mkp_123');
    vi.clearAllMocks();
  });

  it('should process checkout, split orders by vendor, and publish events', async () => {
    const mockHandler = vi.fn();
    eventBus.subscribe('order.created', mockHandler);
    eventBus.subscribe('inventory.updated', mockHandler);
    eventBus.subscribe('payment.completed', mockHandler);

    const cart: MarketplaceCartItem[] = [
      {
        id: 'item_1',
        tenantId: 'tnt_vendor_1',
        vendorId: 'tnt_vendor_1',
        sku: 'SKU-001',
        name: 'Vendor 1 Product',
        quantity: 10,
        price: 10000, // 100 NGN
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        cartQuantity: 2
      },
      {
        id: 'item_2',
        tenantId: 'tnt_vendor_2',
        vendorId: 'tnt_vendor_2',
        sku: 'SKU-002',
        name: 'Vendor 2 Product',
        quantity: 5,
        price: 5000, // 50 NGN
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
        cartQuantity: 1
      }
    ];

    const order = await marketplaceCore.checkout(cart, 'customer@example.com');

    expect(order.totalAmount).toBe(25000); // (2 * 10000) + (1 * 5000)
    expect(order.status).toBe('PAID');
    expect(order.vendorOrders.length).toBe(2);
    
    const vendor1Order = order.vendorOrders.find(vo => vo.vendorId === 'tnt_vendor_1');
    expect(vendor1Order?.subTotal).toBe(20000);

    const vendor2Order = order.vendorOrders.find(vo => vo.vendorId === 'tnt_vendor_2');
    expect(vendor2Order?.subTotal).toBe(5000);

    // Wait for async event publishing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Should have published 4 events: 2x inventory.updated, 1x order.created, 1x payment.completed
    expect(mockHandler).toHaveBeenCalledTimes(4);
  });
});
