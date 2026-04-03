/**
 * @webwaka/core — CommerceEvents Constants Registry
 * Centralised event type strings for the WebWaka platform event bus.
 * Replaces all hardcoded string literals in registerHandler() calls.
 * Build Once Use Infinitely — used by commerce, logistics, admin repos.
 */

export const CommerceEvents = {
  INVENTORY_UPDATED: 'inventory.updated',
  ORDER_CREATED: 'order.created',
  ORDER_READY_DELIVERY: 'order.ready_for_delivery',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_REFUNDED: 'payment.refunded',
  SHIFT_CLOSED: 'shift.closed',
  CART_ABANDONED: 'cart.abandoned',
  SUBSCRIPTION_CHARGE: 'subscription.charge_due',
  DELIVERY_QUOTE: 'delivery.quote',
  DELIVERY_STATUS: 'delivery.status_changed',
  VENDOR_KYC_SUBMITTED: 'vendor.kyc_submitted',
  VENDOR_KYC_APPROVED: 'vendor.kyc_approved',
  VENDOR_KYC_REJECTED: 'vendor.kyc_rejected',
  STOCK_ADJUSTED: 'stock.adjusted',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  PURCHASE_ORDER_RECEIVED: 'purchase_order.received',
  FLASH_SALE_STARTED: 'flash_sale.started',
  FLASH_SALE_ENDED: 'flash_sale.ended',
  ORDER_FULFILLMENT_ASSIGNED: 'order.fulfillment_assigned',
  ORDER_PACKED: 'order.packed',
} as const;

export type CommerceEventType = typeof CommerceEvents[keyof typeof CommerceEvents];
