import { eventBus } from '../../core/event-bus';
import { InventoryItem } from '../../core/db/schema';

export interface MarketplaceCartItem extends InventoryItem {
  cartQuantity: number;
  vendorId: string; // The tenantId of the vendor
}

export interface VendorSubOrder {
  vendorId: string;
  items: MarketplaceCartItem[];
  subTotal: number; // Integer (kobo/cents)
}

export interface MarketplaceOrder {
  id: string;
  marketplaceId: string;
  customerId: string;
  vendorOrders: VendorSubOrder[];
  totalAmount: number; // Integer (kobo/cents)
  status: 'PENDING' | 'PAID' | 'FAILED';
  paymentReference?: string;
  createdAt: number;
}

export class MarketplaceCore {
  private marketplaceId: string;

  constructor(marketplaceId: string) {
    this.marketplaceId = marketplaceId;
  }

  // Mock Paystack/Flutterwave integration (Nigeria First Invariant)
  async processPayment(amount: number, email: string): Promise<{ success: boolean; reference: string }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          success: true,
          reference: `pay_mkp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        });
      }, 500);
    });
  }

  async checkout(cart: MarketplaceCartItem[], customerEmail: string): Promise<MarketplaceOrder> {
    const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
    
    // Group items by vendor
    const vendorGroups = cart.reduce((acc, item) => {
      if (!acc[item.vendorId]) {
        acc[item.vendorId] = [];
      }
      acc[item.vendorId].push(item);
      return acc;
    }, {} as Record<string, MarketplaceCartItem[]>);

    const vendorOrders: VendorSubOrder[] = Object.entries(vendorGroups).map(([vendorId, items]) => ({
      vendorId,
      items,
      subTotal: items.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0)
    }));

    const orderId = `ord_mkp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 1. Process Payment (Nigeria First)
    const paymentResult = await this.processPayment(totalAmount, customerEmail);

    if (!paymentResult.success) {
      throw new Error('Payment failed');
    }

    const order: MarketplaceOrder = {
      id: orderId,
      marketplaceId: this.marketplaceId,
      customerId: customerEmail,
      vendorOrders,
      totalAmount,
      status: 'PAID',
      paymentReference: paymentResult.reference,
      createdAt: Date.now()
    };

    // 2. Publish events to the Platform Event Bus
    
    // Publish marketplace order created event
    await eventBus.publish({
      id: `evt_ord_${Date.now()}`,
      tenantId: this.marketplaceId,
      type: 'order.created',
      sourceModule: 'multi_vendor_marketplace',
      timestamp: Date.now(),
      payload: { order }
    });

    // Publish payment completed event
    await eventBus.publish({
      id: `evt_pay_${Date.now()}`,
      tenantId: this.marketplaceId,
      type: 'payment.completed',
      sourceModule: 'multi_vendor_marketplace',
      timestamp: Date.now(),
      payload: { 
        orderId: order.id, 
        amount: totalAmount, 
        method: 'PAYSTACK',
        reference: paymentResult.reference,
        splits: vendorOrders.map(vo => ({ vendorId: vo.vendorId, amount: vo.subTotal }))
      }
    });

    // Publish inventory updates for each vendor
    for (const subOrder of vendorOrders) {
      for (const item of subOrder.items) {
        const updatedQuantity = item.quantity - item.cartQuantity;
        
        const inventoryUpdate = {
          ...item,
          quantity: updatedQuantity,
          version: item.version + 1
        };

        // Publish event scoped to the specific vendor's tenantId
        await eventBus.publish({
          id: `evt_inv_${Date.now()}_${item.id}`,
          tenantId: subOrder.vendorId,
          type: 'inventory.updated',
          sourceModule: 'multi_vendor_marketplace',
          timestamp: Date.now(),
          payload: { item: inventoryUpdate }
        });
      }
    }

    return order;
  }
}
