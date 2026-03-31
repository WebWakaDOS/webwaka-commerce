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
import { registerHandler, clearHandlers, publishEvent } from '../index';
import { CommerceEvents, createSmsProvider, createKycProvider } from '@webwaka/core';

// ─── Handler: inventory.updated → invalidate catalog KV cache ────────────────

export async function handleInventoryUpdated(
  event: WebWakaEvent<{ productId?: string; tenantId?: string }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  if (!tenantId) return;

  // KV cache invalidation — version-counter approach.
  // Increment the tenant's catalog version; the MV catalog route includes this
  // version in its cache key, so all stale entries become un-hittable instantly.
  // Old entries expire naturally via their TTL (60 s).
  if (env.CATALOG_CACHE) {
    const versionKey = `catalog_version:${tenantId}`;
    await env.CATALOG_CACHE.put(versionKey, String(Date.now()), {
      expirationTtl: 86400, // 24 h; a new version is written on every update anyway
    });
  }
}

// ─── Handler: order.created → log to platform_order_log ──────────────────────

export async function handleOrderCreated(
  event: WebWakaEvent<{ order?: { id?: string } }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  if (!tenantId) return;

  const orderId = (event.payload?.order?.id ?? event.id) as string;
  const logId = `pol_${event.id}`;
  const createdAt = new Date(event.timestamp).toISOString();

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO platform_order_log
         (id, tenant_id, order_id, source_module, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(logId, tenantId, orderId, event.sourceModule, createdAt)
      .run();
  } catch {
    // Table may not exist yet; migration 0002_stubs.sql creates it.
    // Non-fatal: CF Queues will not retry a handler that returns normally.
  }
}

// ─── Handler: shift.closed → compute Z-report and insert shift_analytics ─────

export async function handleShiftClosed(
  event: WebWakaEvent<{ sessionId?: string }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  const sessionId = event.payload?.sessionId;
  if (!tenantId || !sessionId) return;

  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS total_orders,
              COALESCE(SUM(total_amount), 0) AS revenue_kobo,
              COALESCE(AVG(total_amount), 0) AS avg_order_kobo
       FROM orders
       WHERE tenant_id = ? AND session_id = ? AND deleted_at IS NULL`,
    )
      .bind(tenantId, sessionId)
      .first<{ total_orders: number; revenue_kobo: number; avg_order_kobo: number }>();

    if (!row) return;

    const analyticsId = `sa_${event.id}`;
    const recordedAt = new Date(event.timestamp).toISOString();

    await env.DB.prepare(
      `INSERT OR IGNORE INTO shift_analytics
         (id, tenant_id, session_id, total_orders, revenue_kobo, avg_order_kobo, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        analyticsId,
        tenantId,
        sessionId,
        row.total_orders,
        row.revenue_kobo,
        Math.round(row.avg_order_kobo),
        recordedAt,
      )
      .run();
  } catch {
    // Non-fatal — table may not exist until migration 0002_stubs.sql runs.
  }
}

// ─── Handler: vendor.kyc.submitted → automated KYC pipeline ──────────────────
//
// Pipeline:
//   1. INSERT OR IGNORE kyc_review_queue (idempotent)
//   2. Fetch vendor: bvn_hash, rc_number, name, phone, onboarding_data_json
//   3. If KYC credentials not configured → MANUAL_REVIEW
//   4. createKycProvider + Promise.allSettled([verifyBvn, verifyCac])
//   5. AUTO_APPROVED  — both pass
//      AUTO_REJECTED  — BVN fails
//      MANUAL_REVIEW  — BVN passes, CAC fails/missing
//   6. UPDATE kyc_review_queue + vendors
//   7. Publish VENDOR_KYC_APPROVED | VENDOR_KYC_REJECTED event
//   8. WhatsApp notification via Termii

type KycQueueStatus = 'PENDING' | 'AUTO_APPROVED' | 'AUTO_REJECTED' | 'MANUAL_REVIEW';

async function _updateKycQueueStatus(
  db: D1Database,
  queueId: string,
  tenantId: string,
  vendorId: string,
  status: KycQueueStatus,
): Promise<void> {
  const reviewedAt = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE kyc_review_queue
       SET status = ?, reviewed_at = ?
       WHERE id = ? AND tenant_id = ? AND vendor_id = ?`,
    ).bind(status, reviewedAt, queueId, tenantId, vendorId).run();
  } catch { /* non-fatal */ }
}

async function _sendKycWhatsApp(
  env: Env,
  phone: string | null,
  message: string,
): Promise<void> {
  if (!phone || !env.TERMII_API_KEY) return;
  try {
    const sms = createSmsProvider(env.TERMII_API_KEY);
    await sms.sendOtp(phone, message, 'whatsapp');
  } catch { /* non-fatal: SMS failure must never block KYC pipeline */ }
}

export async function handleVendorKycSubmitted(
  event: WebWakaEvent<{ vendorId?: string }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  const vendorId = event.payload?.vendorId;
  if (!tenantId || !vendorId) return;

  const queueId = `kyc_${event.id}`;
  const submittedAt = new Date(event.timestamp).toISOString();
  const now = Date.now();

  // ── 1. Insert into review queue (idempotent) ─────────────────────────────
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO kyc_review_queue
         (id, tenant_id, vendor_id, submitted_at, status)
       VALUES (?, ?, ?, ?, 'PENDING')`,
    ).bind(queueId, tenantId, vendorId, submittedAt).run();
  } catch { /* non-fatal — table may not exist until migration 0002_stubs.sql runs */ }

  // ── 2. Fetch vendor KYC data ──────────────────────────────────────────────
  let vendor: {
    bvn_hash: string | null;
    rc_number: string | null;
    name: string;
    phone: string | null;
    onboarding_data_json: string | null;
  } | null = null;

  try {
    vendor = await env.DB.prepare(
      `SELECT bvn_hash, rc_number, name, phone, onboarding_data_json
       FROM vendors
       WHERE id = ? AND marketplace_tenant_id = ? AND deleted_at IS NULL`,
    ).bind(vendorId, tenantId).first<{
      bvn_hash: string | null;
      rc_number: string | null;
      name: string;
      phone: string | null;
      onboarding_data_json: string | null;
    }>();
  } catch { /* fall through to MANUAL_REVIEW */ }

  // ── 3. Guard: no vendor data → MANUAL_REVIEW ─────────────────────────────
  if (!vendor || !vendor.bvn_hash) {
    await _updateKycQueueStatus(env.DB, queueId, tenantId, vendorId, 'MANUAL_REVIEW');
    await _sendKycWhatsApp(
      env,
      vendor?.phone ?? null,
      'Your seller application is under manual review. We will contact you within 48 hours.',
    );
    return;
  }

  // ── 4. Parse personal identity fields from onboarding_data_json ───────────
  let firstName = '';
  let lastName = '';
  let dob = '';
  let businessNameForCac = vendor.name;

  if (vendor.onboarding_data_json) {
    try {
      const od = JSON.parse(vendor.onboarding_data_json) as Record<string, unknown>;
      if (typeof od.firstName === 'string') firstName = od.firstName;
      if (typeof od.lastName === 'string') lastName = od.lastName;
      if (typeof od.dob === 'string') dob = od.dob;
      if (typeof od.businessNameForCac === 'string') businessNameForCac = od.businessNameForCac;
    } catch { /* malformed JSON — use defaults */ }
  }

  // ── 5. Guard: KYC credentials not configured → MANUAL_REVIEW ─────────────
  const partnerId = env.SMILE_IDENTITY_PARTNER_ID;
  const smileApiKey = env.SMILE_IDENTITY_API_KEY;
  const premblyApiKey = env.PREMBLY_API_KEY;
  const premblyAppId = env.PREMBLY_APP_ID;

  if (!partnerId || !smileApiKey || !premblyApiKey || !premblyAppId) {
    await _updateKycQueueStatus(env.DB, queueId, tenantId, vendorId, 'MANUAL_REVIEW');
    await _sendKycWhatsApp(
      env,
      vendor.phone,
      'Your seller application is under manual review. We will contact you within 48 hours.',
    );
    return;
  }

  // ── 6. Run BVN + CAC verification in parallel ─────────────────────────────
  const provider = createKycProvider(partnerId, smileApiKey, premblyApiKey, premblyAppId);

  const [bvnSettled, cacSettled] = await Promise.allSettled([
    provider.verifyBvn(vendor.bvn_hash, firstName, lastName, dob),
    vendor.rc_number
      ? provider.verifyCac(vendor.rc_number, businessNameForCac)
      : Promise.resolve({ verified: false, reason: 'no_rc_number', provider: 'prembly' }),
  ]);

  const bvnResult = bvnSettled.status === 'fulfilled'
    ? bvnSettled.value
    : { verified: false, reason: 'provider_error', provider: 'smile_identity' };
  const cacResult = cacSettled.status === 'fulfilled'
    ? cacSettled.value
    : { verified: false, reason: 'provider_error', provider: 'prembly' };

  const bvnVerified = bvnResult.verified;
  const cacVerified = cacResult.verified;

  // ── 7. Determine outcome ──────────────────────────────────────────────────
  let newStatus: KycQueueStatus;
  if (bvnVerified && cacVerified) {
    newStatus = 'AUTO_APPROVED';
  } else if (!bvnVerified) {
    newStatus = 'AUTO_REJECTED';
  } else {
    // bvnVerified && !cacVerified — needs manual review of CAC docs
    newStatus = 'MANUAL_REVIEW';
  }

  // ── 8. Persist queue status ───────────────────────────────────────────────
  await _updateKycQueueStatus(env.DB, queueId, tenantId, vendorId, newStatus);

  // ── 9. Act on outcome ─────────────────────────────────────────────────────
  if (newStatus === 'AUTO_APPROVED') {
    // Update vendor: approved + activate
    try {
      await env.DB.prepare(
        `UPDATE vendors
         SET kyc_status = 'approved', kyc_approved_at = ?, active = 1, updated_at = ?
         WHERE id = ? AND marketplace_tenant_id = ?`,
      ).bind(now, now, vendorId, tenantId).run();
    } catch { /* non-fatal */ }

    // Publish VENDOR_KYC_APPROVED event
    await publishEvent(env.COMMERCE_EVENTS, {
      id: `evt_kyc_approved_${now}_${Math.random().toString(36).slice(2, 9)}`,
      tenantId,
      type: CommerceEvents.VENDOR_KYC_APPROVED,
      sourceModule: 'event-bus',
      timestamp: now,
      payload: { vendorId, tenantId },
    }).catch(() => { /* non-fatal */ });

    // WhatsApp: approval notification
    await _sendKycWhatsApp(
      env,
      vendor.phone,
      `Congratulations! Your WebWaka seller account for ${vendor.name} is now LIVE. You can start listing products and receiving orders immediately.`,
    );

  } else if (newStatus === 'AUTO_REJECTED') {
    // Update vendor: rejected
    try {
      await env.DB.prepare(
        `UPDATE vendors
         SET kyc_status = 'rejected',
             kyc_rejection_reason = ?,
             updated_at = ?
         WHERE id = ? AND marketplace_tenant_id = ?`,
      ).bind(
        `BVN verification failed: ${bvnResult.reason ?? 'identity mismatch'}`,
        now, vendorId, tenantId,
      ).run();
    } catch { /* non-fatal */ }

    // Publish VENDOR_KYC_REJECTED event
    await publishEvent(env.COMMERCE_EVENTS, {
      id: `evt_kyc_rejected_${now}_${Math.random().toString(36).slice(2, 9)}`,
      tenantId,
      type: CommerceEvents.VENDOR_KYC_REJECTED,
      sourceModule: 'event-bus',
      timestamp: now,
      payload: { vendorId, tenantId, reason: bvnResult.reason },
    }).catch(() => { /* non-fatal */ });

    // WhatsApp: rejection notification
    await _sendKycWhatsApp(
      env,
      vendor.phone,
      'We could not verify your BVN details. Please check your information and resubmit your application, or contact support for assistance.',
    );

  } else {
    // MANUAL_REVIEW — BVN passed but CAC needs review
    await _sendKycWhatsApp(
      env,
      vendor.phone,
      'Your BVN has been verified. Your CAC business registration is under manual review. We will notify you within 48 hours.',
    );
  }
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

// ─── Handler: delivery.quote → store quotes in KV for frontend (P05-T2) ──────

export async function handleDeliveryQuote(
  event: WebWakaEvent<{ orderId?: string; quotes?: unknown }>,
  env: Env,
): Promise<void> {
  const { orderId, quotes } = event.payload;
  if (!orderId || quotes === undefined) return;

  if (env.CATALOG_CACHE) {
    await env.CATALOG_CACHE.put(
      `delivery_options:${orderId}`,
      JSON.stringify(quotes),
      { expirationTtl: 3600 },
    );
  }
}

// ─── Handler: delivery.status_changed → update order status + notify (P05-T4) ─

export async function handleDeliveryStatusUpdated(
  event: WebWakaEvent<{
    orderId: string;
    tenantId: string;
    status: string;
    trackingUrl?: string;
    provider?: string;
    estimatedDelivery?: string;
  }>,
  env: Env,
): Promise<void> {
  const { orderId, tenantId, status, trackingUrl, provider, estimatedDelivery } = event.payload;
  if (!orderId || !tenantId || !status) return;

  // Map canonical logistics status → internal order status
  const statusMap: Record<string, string> = {
    PICKED_UP: 'PROCESSING',
    IN_TRANSIT: 'SHIPPED',
    OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
    DELIVERED: 'DELIVERED',
    FAILED: 'DELIVERY_FAILED',
    RETURNED: 'RETURNED',
  };

  const mappedStatus = statusMap[status];
  if (!mappedStatus) return;

  const now = Date.now();

  // 1. Update order status in D1
  try {
    await env.DB.prepare(
      `UPDATE orders
       SET order_status = ?, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).bind(mappedStatus, now, orderId, tenantId).run();
  } catch {
    // Non-fatal — order may belong to another module's table
  }

  // 2. Fetch customer phone for WhatsApp notification
  let customerPhone: string | null = null;
  try {
    const row = await env.DB.prepare(
      `SELECT customer_phone FROM orders WHERE id = ? AND tenant_id = ?`,
    ).bind(orderId, tenantId).first<{ customer_phone: string | null }>();
    customerPhone = row?.customer_phone ?? null;
  } catch { /* non-fatal */ }

  // 3. Send WhatsApp notification via SMS provider
  if (customerPhone && env.TERMII_API_KEY) {
    const messageMap: Record<string, string> = {
      PICKED_UP: `Your order has been picked up by ${provider ?? 'our delivery partner'}. Track here: ${trackingUrl ?? 'N/A'}`,
      IN_TRANSIT: `Your order is in transit. Estimated delivery: ${estimatedDelivery ?? 'soon'}`,
      OUT_FOR_DELIVERY: 'Your order is out for delivery today! Please be available.',
      DELIVERED: 'Your order has been delivered! Thank you for shopping with us.',
      FAILED: 'Delivery attempt failed. We will retry. Contact support if you need help.',
      RETURNED: 'Your order has been returned. A refund will be processed shortly.',
    };
    const message = messageMap[status];
    if (message) {
      try {
        const sms = createSmsProvider(env.TERMII_API_KEY);
        await sms.sendOtp(customerPhone, message, 'whatsapp');
      } catch { /* non-fatal: SMS failure must not block order processing */ }
    }
  }

  // 4. Invalidate order KV cache
  if (env.CATALOG_CACHE) {
    try {
      await env.CATALOG_CACHE.delete(`order:${orderId}`);
    } catch { /* non-fatal */ }
  }
}

// ─── Registration (called once at module init) ────────────────────────────────

/**
 * Register all server-side consumer handlers with the dispatchEvent registry.
 * Safe to call multiple times — clears the registry first so handlers always
 * run with the current env binding and are never duplicated.
 *
 * IMPORTANT: This function receives `env` because handlers need Worker
 * bindings (DB, KV). The env is curried into each handler via a closure.
 */
export function registerAllHandlers(env: Env): void {
  clearHandlers();

  registerHandler(CommerceEvents.INVENTORY_UPDATED, (event) =>
    handleInventoryUpdated(event as WebWakaEvent<{ productId?: string; tenantId?: string }>, env),
  );
  registerHandler(CommerceEvents.ORDER_CREATED, (event) =>
    handleOrderCreated(event as WebWakaEvent<{ order?: { id?: string } }>, env),
  );
  registerHandler(CommerceEvents.SHIFT_CLOSED, (event) =>
    handleShiftClosed(event as WebWakaEvent<{ sessionId?: string }>, env),
  );
  registerHandler(CommerceEvents.VENDOR_KYC_SUBMITTED, (event) =>
    handleVendorKycSubmitted(event as WebWakaEvent<{ vendorId?: string }>, env),
  );
  registerHandler('delivery.booking.confirmed', (event) =>
    handleDeliveryBookingConfirmed(event as WebWakaEvent<{
      vendor_order_id: string;
      tracking_number: string;
      tracking_url?: string;
      carrier?: string;
      estimated_delivery?: number;
    }>, env),
  );
  registerHandler(CommerceEvents.DELIVERY_QUOTE, (event) =>
    handleDeliveryQuote(event as WebWakaEvent<{ orderId?: string; quotes?: unknown }>, env),
  );
  registerHandler(CommerceEvents.DELIVERY_STATUS, (event) =>
    handleDeliveryStatusUpdated(event as WebWakaEvent<{
      orderId: string;
      tenantId: string;
      status: string;
      trackingUrl?: string;
      provider?: string;
      estimatedDelivery?: string;
    }>, env),
  );
}
