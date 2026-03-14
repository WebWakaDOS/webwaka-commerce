import { SyncManager } from '../../core/sync/client';
import { eventBus } from '../../core/event-bus';
import { InventoryItem } from '../../core/db/schema';

export interface CartItem extends InventoryItem {
  cartQuantity: number;
}

export interface Order {
  id: string;
  tenantId: string;
  items: CartItem[];
  totalAmount: number; // Integer (kobo/cents)
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  paymentMethod: 'CASH' | 'CARD' | 'TRANSFER';
  createdAt: number;
}

export class POSCore {
  private syncManager: SyncManager;
  private tenantId: string;

  constructor(tenantId: string, syncApiUrl: string) {
    this.tenantId = tenantId;
    this.syncManager = new SyncManager(tenantId, syncApiUrl);
  }

  // Process a checkout offline-first
  async checkout(cart: CartItem[], paymentMethod: 'CASH' | 'CARD' | 'TRANSFER'): Promise<Order> {
    const totalAmount = cart.reduce((sum, item) => sum + (item.price * item.cartQuantity), 0);
    
    const order: Order = {
      id: `ord_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      tenantId: this.tenantId,
      items: cart,
      totalAmount,
      status: 'COMPLETED',
      paymentMethod,
      createdAt: Date.now()
    };

    // 1. Queue the order creation mutation (Offline First)
    await this.syncManager.queueMutation(
      'order',
      order.id,
      'CREATE',
      order,
      1
    );

    // 2. Queue inventory updates for each item
    for (const item of cart) {
      const updatedQuantity = item.quantity - item.cartQuantity;
      
      const inventoryUpdate = {
        ...item,
        quantity: updatedQuantity,
        version: item.version + 1
      };

      await this.syncManager.queueMutation(
        'inventory',
        item.id,
        'UPDATE',
        inventoryUpdate,
        inventoryUpdate.version
      );

      // 3. Publish events to the Platform Event Bus for cross-module communication
      // In a real PWA, this would happen on the server after sync, but for local optimistic UI updates:
      await eventBus.publish({
        id: `evt_inv_${Date.now()}`,
        tenantId: this.tenantId,
        type: 'inventory.updated',
        sourceModule: 'retail_pos',
        timestamp: Date.now(),
        payload: { item: inventoryUpdate }
      });
    }

    // Publish order created event
    await eventBus.publish({
      id: `evt_ord_${Date.now()}`,
      tenantId: this.tenantId,
      type: 'order.created',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { order }
    });

    // Publish payment completed event (which would trigger ledger entry creation)
    await eventBus.publish({
      id: `evt_pay_${Date.now()}`,
      tenantId: this.tenantId,
      type: 'payment.completed',
      sourceModule: 'retail_pos',
      timestamp: Date.now(),
      payload: { 
        orderId: order.id, 
        amount: totalAmount, 
        method: paymentMethod 
      }
    });

    return order;
  }
}
