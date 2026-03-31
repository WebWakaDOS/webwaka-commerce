import { eventBus } from '../../core/event-bus';
import { InventoryItem } from '../../core/db/schema';
import { createPaymentProvider, CommerceEvents } from '@webwaka/core';

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
  private paystackSecret: string;

  constructor(tenantId: string, paystackSecret = '') {
    this.tenantId = tenantId;
    this.paystackSecret = paystackSecret;
  }

  async checkout(cart: StorefrontCartItem[], customerEmail: string): Promise<StorefrontOrder> {
    const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);

    const orderId = `ord_sv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const payment = createPaymentProvider(this.paystackSecret);

    const chargeResult = await payment.verifyCharge(
      `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    );

    if (!chargeResult.success) {
      throw new Error('Payment failed');
    }

    const order: StorefrontOrder = {
      id: orderId,
      tenantId: this.tenantId,
      customerId: customerEmail,
      items: cart,
      totalAmount,
      status: 'PAID',
      paymentReference: chargeResult.reference,
      createdAt: Date.now()
    };

    // Publish order created event
    await eventBus.publish({
      id: `evt_ord_${Date.now()}`,
      tenantId: this.tenantId,
      type: CommerceEvents.ORDER_CREATED,
      sourceModule: 'single_vendor_storefront',
      timestamp: Date.now(),
      payload: { order }
    });

    // Publish payment received event
    await eventBus.publish({
      id: `evt_pay_${Date.now()}`,
      tenantId: this.tenantId,
      type: CommerceEvents.PAYMENT_COMPLETED,
      sourceModule: 'single_vendor_storefront',
      timestamp: Date.now(),
      payload: {
        orderId: order.id,
        amount: totalAmount,
        method: 'PAYSTACK',
        reference: chargeResult.reference
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
        type: CommerceEvents.INVENTORY_UPDATED,
        sourceModule: 'single_vendor_storefront',
        timestamp: Date.now(),
        payload: { item: inventoryUpdate }
      });
    }

    return order;
  }
}
