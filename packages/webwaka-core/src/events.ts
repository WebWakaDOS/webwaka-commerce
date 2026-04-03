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
  // T-COM-05: RMA (Return Merchandise Authorization) lifecycle events
  RMA_REQUESTED: 'rma.requested',
  RMA_APPROVED: 'rma.approved',
  RMA_DISPUTED: 'rma.disputed',
  RMA_REVERSE_PICKUP_REQUESTED: 'rma.reverse_pickup_requested',
  RMA_RECEIVED: 'rma.received',
  RMA_REFUND_INITIATED: 'rma.refund_initiated',
  RMA_REJECTED: 'rma.rejected',
  // Cross-service escrow events consumed by Fintech / Central Mgmt
  VENDOR_PAYOUT_HOLD: 'vendor.payout.hold',
  VENDOR_PAYOUT_RELEASE: 'vendor.payout.release',
} as const;

export type CommerceEventType = typeof CommerceEvents[keyof typeof CommerceEvents];
