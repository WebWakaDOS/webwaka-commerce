import { eventBus } from '../../core/event-bus';
import { InventoryItem } from '../../core/db/schema';

export interface StorefrontCartItem extends InventoryItem {
  cartQuantity: number;
}

export interface StorefrontOrder {
  id: string;
  tenantId: string;
  customerId: string;
  items: StorefrontCartItem[];
  totalAmount: number; // Integer (kobo/cents)
  status: 'PENDING' | 'PAID' | 'FAILED';
  paymentReference?: string;
  createdAt: number;
}

export class StorefrontCore {
  private tenantId: string;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
  }

  // Paystack integration (Nigeria First Invariant)
  // The browser checkout flow uses the Paystack Inline SDK (handlePayWithPaystack in app.tsx).
  // This method is used server-side for legacy / unit-test purposes only.
  async processPayment(amount: number, _email: string): Promise<{ success: boolean; reference: string }> {
    const reference = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    return { success: amount > 0, reference };
  }

  async checkout(cart: StorefrontCartItem[], customerEmail: string): Promise<StorefrontOrder> {
    const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
    
    const orderId = `ord_sv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 1. Process Payment (Nigeria First)
    const paymentResult = await this.processPayment(totalAmount, customerEmail);

    if (!paymentResult.success) {
      throw new Error('Payment failed');
    }

    const order: StorefrontOrder = {
      id: orderId,
      tenantId: this.tenantId,
      customerId: customerEmail,
      items: cart,
      totalAmount,
      status: 'PAID',
      paymentReference: paymentResult.reference,
      createdAt: Date.now()
    };

    // 2. Publish events to the Platform Event Bus
    
    // Publish order created event
    await eventBus.publish({
      id: `evt_ord_${Date.now()}`,
      tenantId: this.tenantId,
      type: 'order.created',
      sourceModule: 'single_vendor_storefront',
      timestamp: Date.now(),
      payload: { order }
    });

    // Publish payment completed event
    await eventBus.publish({
      id: `evt_pay_${Date.now()}`,
      tenantId: this.tenantId,
      type: 'payment.completed',
      sourceModule: 'single_vendor_storefront',
      timestamp: Date.now(),
      payload: { 
        orderId: order.id, 
        amount: totalAmount, 
        method: 'PAYSTACK',
        reference: paymentResult.reference
      }
    });

    // Publish inventory updates
    for (const item of cart) {
      const updatedQuantity = item.quantity - item.cartQuantity;
      
      const inventoryUpdate = {
        ...item,
        quantity: updatedQuantity,
        version: item.version + 1
      };

      await eventBus.publish({
        id: `evt_inv_${Date.now()}_${item.id}`,
        tenantId: this.tenantId,
        type: 'inventory.updated',
        sourceModule: 'single_vendor_storefront',
        timestamp: Date.now(),
        payload: { item: inventoryUpdate }
      });
    }

    return order;
  }
}
