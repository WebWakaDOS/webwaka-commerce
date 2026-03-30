/**
 * CF Queue Consumer Handlers
 *
 * Each handler is invoked from the `queue` export in worker.ts when a
 * WebWakaEvent is dequeued from the Cloudflare Queue.
 *
 * Rules:
 * - Every handler MUST be idempotent (CF Queues delivers at-least-once).
 * - Every handler MUST be a named export so it can be unit-tested in isolation.
 * - Handlers MUST NOT query another module's D1 tables directly [EVT].
 * - Handlers MUST enforce tenant_id isolation [MTT].
 */

import type { Env } from '../../../worker';
import type { WebWakaEvent } from '../index';
import { registerHandler } from '../index';

// ─── Handler: inventory.updated → invalidate catalog KV cache ────────────────

export async function handleInventoryUpdated(
  event: WebWakaEvent<{ productId?: string; tenantId?: string }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  if (!tenantId) return;

  // Invalidate all catalog cache keys for this tenant.
  // KV does not support prefix-delete, so we delete the known page keys
  // (pages 1–5, most common). Full invalidation happens via TTL (60s).
  const knownCacheKeys = [
    `catalog:${tenantId}:1`,
    `catalog:${tenantId}:2`,
    `catalog:${tenantId}:3`,
    `catalog:${tenantId}:featured`,
    `catalog:${tenantId}:search`,
  ];

  await Promise.allSettled(
    knownCacheKeys.map((key) => env.CATALOG_CACHE.delete(key)),
  );
}

// ─── Handler: order.created → placeholder (Super Admin V2 will consume) ───────

export async function handleOrderCreated(
  event: WebWakaEvent,
  _env: Env,
): Promise<void> {
  // Consumed by webwaka-super-admin-v2 via CF Queues subscription.
  // This handler is a local stub — no action needed in commerce worker.
  // Event schema: see docs/EVENT_SCHEMAS.md > order.created
  void event;
}

// ─── Handler: shift.closed → placeholder (analytics pipeline) ─────────────────

export async function handleShiftClosed(
  event: WebWakaEvent,
  _env: Env,
): Promise<void> {
  // Future: push Z-report summary to analytics pipeline.
  // Currently a no-op stub.
  void event;
}

// ─── Handler: vendor.kyc.submitted → placeholder (Super Admin V2 review) ─────

export async function handleVendorKycSubmitted(
  event: WebWakaEvent,
  _env: Env,
): Promise<void> {
  // Consumed by webwaka-super-admin-v2 KYC review queue.
  // No action in commerce worker.
  void event;
}

// ─── Handler: delivery.booking.confirmed → update vendor_orders tracking ──────

export async function handleDeliveryBookingConfirmed(
  event: WebWakaEvent<{
    vendor_order_id: string;
    tracking_number: string;
    tracking_url?: string;
    carrier?: string;
    estimated_delivery?: number;
  }>,
  env: Env,
): Promise<void> {
  const { vendor_order_id, tracking_number, tracking_url, carrier, estimated_delivery } =
    event.payload;

  if (!vendor_order_id || !tracking_number) return;

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE vendor_orders
     SET fulfilment_status = 'shipped',
         tracking_number    = ?,
         tracking_url       = ?,
         shipped_at         = ?,
         updated_at         = ?
     WHERE id = ? AND tenant_id = ?`,
  )
    .bind(
      tracking_number,
      tracking_url ?? null,
      now,
      now,
      vendor_order_id,
      event.tenantId,
    )
    .run();

  void carrier;
  void estimated_delivery;
}

// ─── Handler: delivery.status.updated → map logistics status to fulfilment ────

export async function handleDeliveryStatusUpdated(
  event: WebWakaEvent<{
    vendor_order_id: string;
    logistics_status: string;
  }>,
  env: Env,
): Promise<void> {
  const { vendor_order_id, logistics_status } = event.payload;
  if (!vendor_order_id) return;

  const fulfilmentStatusMap: Record<string, string> = {
    picked_up: 'shipped',
    in_transit: 'shipped',
    out_for_delivery: 'shipped',
    delivered: 'delivered',
    failed_delivery: 'pending',
    returned: 'cancelled',
  };

  const fulfilmentStatus = fulfilmentStatusMap[logistics_status];
  if (!fulfilmentStatus) return;

  const now = Date.now();

  if (fulfilmentStatus === 'delivered') {
    await env.DB.prepare(
      `UPDATE vendor_orders
       SET fulfilment_status = 'delivered', delivered_at = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
      .bind(now, now, vendor_order_id, event.tenantId)
      .run();
  } else {
    await env.DB.prepare(
      `UPDATE vendor_orders
       SET fulfilment_status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    )
      .bind(fulfilmentStatus, now, vendor_order_id, event.tenantId)
      .run();
  }
}

// ─── Registration (called once at module init) ────────────────────────────────

let _registered = false;

/**
 * Register all server-side consumer handlers with the dispatchEvent registry.
 * Safe to call multiple times (idempotent via `_registered` guard).
 *
 * IMPORTANT: This function receives `env` because handlers need Worker
 * bindings (DB, KV). The env is curried into each handler via a closure.
 */
export function registerAllHandlers(env: Env): void {
  if (_registered) return;
  _registered = true;

  registerHandler('inventory.updated', (event) =>
    handleInventoryUpdated(event as WebWakaEvent<{ productId?: string; tenantId?: string }>, env),
  );
  registerHandler('order.created', (event) => handleOrderCreated(event, env));
  registerHandler('shift.closed', (event) => handleShiftClosed(event, env));
  registerHandler('vendor.kyc.submitted', (event) => handleVendorKycSubmitted(event, env));
  registerHandler('delivery.booking.confirmed', (event) =>
    handleDeliveryBookingConfirmed(event as WebWakaEvent<{
      vendor_order_id: string;
      tracking_number: string;
      tracking_url?: string;
      carrier?: string;
      estimated_delivery?: number;
    }>, env),
  );
  registerHandler('delivery.status.updated', (event) =>
    handleDeliveryStatusUpdated(event as WebWakaEvent<{
      vendor_order_id: string;
      logistics_status: string;
    }>, env),
  );
}
