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
import { CommerceEvents, createSmsProvider } from '@webwaka/core';
import type { IKycProvider, KycVerificationResult } from '@webwaka/core';


// ─── Local KYC Provider Factory (createKycProvider not exported from @webwaka/core) ───
// Implements IKycProvider by calling Smile Identity (BVN) and Prembly (CAC) REST APIs.
function createKycProvider(
  partnerId: string,
  smileApiKey: string,
  premblyApiKey: string,
  premblyAppId: string,
): IKycProvider {
  return {
    async verifyBvn(bvnHash: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult> {
      try {
        const res = await fetch('https://api.smileidentity.com/v1/id_verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            partner_id: partnerId,
            api_key: smileApiKey,
            id_type: 'BVN',
            id_number: bvnHash,
            first_name: firstName,
            last_name: lastName,
            dob,
          }),
        });
        const data = await res.json() as { ResultCode?: string; ResultText?: string };
        const verified = data.ResultCode === '1012' || data.ResultCode === '1020';
        return { verified, reason: data.ResultText ?? undefined, provider: 'smile_identity' };
      } catch (err) {
        throw new Error(`Smile Identity BVN error: ${String(err)}`);
      }
    },
    async verifyNin(ninHash: string, firstName: string, lastName: string): Promise<KycVerificationResult> {
      try {
        const res = await fetch('https://api.smileidentity.com/v1/id_verification', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partner_id: partnerId, api_key: smileApiKey, id_type: 'NIN', id_number: ninHash, first_name: firstName, last_name: lastName }),
        });
        const data = await res.json() as { ResultCode?: string; ResultText?: string };
        const verified = data.ResultCode === '1012' || data.ResultCode === '1020';
        return { verified, reason: data.ResultText ?? undefined, provider: 'smile_identity' };
      } catch (err) {
        throw new Error(`Smile Identity NIN error: ${String(err)}`);
      }
    },
    async verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult> {
      try {
        const res = await fetch(`https://api.prembly.com/identitypass/verification/cac/advance?rc_number=${encodeURIComponent(rcNumber)}`, {
          method: 'GET',
          headers: { 'x-api-key': premblyApiKey, 'app-id': premblyAppId, 'accept': 'application/json' },
        });
        const data = await res.json() as { status?: boolean; data?: { company_name?: string } };
        const verified = data.status === true && !!data.data?.company_name;
        return { verified, reason: verified ? undefined : 'CAC verification failed', provider: 'prembly' };
      } catch (err) {
        throw new Error(`Prembly CAC error: ${String(err)}`);
      }
    },
  };
}

// ─── Handler: inventory.updated → invalidate catalog KV + back-in-stock alerts ─

export async function handleInventoryUpdated(
  event: WebWakaEvent<{ productId?: string; tenantId?: string; newQuantity?: number }>,
  env: Env,
): Promise<void> {
  const tenantId = event.tenantId;
  const productId = event.payload?.productId;
  const newQuantity = event.payload?.newQuantity;
  if (!tenantId) return;

  // 1. KV cache invalidation (three keys)
  if (env.CATALOG_CACHE) {
    // Increment catalog version so stale cache entries become un-hittable
    const versionKey = `catalog_version:${tenantId}`;
    await env.CATALOG_CACHE.put(versionKey, String(Date.now()), { expirationTtl: 86400 });

    // Delete specific product and catalog cache keys
    if (productId) {
      await Promise.allSettled([
        env.CATALOG_CACHE.delete(`catalog:${tenantId}`),
        env.CATALOG_CACHE.delete(`product:${productId}`),
      ]);
    }
  }

  // 2. Back-in-stock WhatsApp notifications for wishlist customers
  if (productId && typeof newQuantity === 'number' && newQuantity > 0 && env.DB) {
    try {
      // Fetch wishlist customers for this product
      const wishlistRows = await env.DB.prepare(
        'SELECT customer_id FROM wishlists WHERE tenant_id = ? AND product_id = ? LIMIT 100'
      ).bind(tenantId, productId).all<{ customer_id: string }>();

      if ((wishlistRows.results?.length ?? 0) === 0) {
        // No wishlist entries; log and return
        await env.DB.prepare(
          'INSERT OR IGNORE INTO inventory_sync_log (id, tenantId, productId, newQuantity, wishlistNotified, createdAt) VALUES (?, ?, ?, ?, 0, ?)'
        ).bind(`isl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, tenantId, productId, newQuantity, new Date().toISOString()).run().catch(() => {});
        return;
      }

      // Fetch product name
      const productRow = await env.DB.prepare(
        'SELECT name FROM products WHERE id = ? AND tenant_id = ?'
      ).bind(productId, tenantId).first<{ name: string }>();
      const productName = productRow?.name ?? 'A product';
      const storeUrl = `https://${tenantId}.webwaka.ng/`;

      let notifiedCount = 0;
      for (const row of wishlistRows.results ?? []) {
        try {
          const custRow = await env.DB.prepare(
            'SELECT phone FROM customers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL'
          ).bind(row.customer_id, tenantId).first<{ phone: string }>();
          if (!custRow?.phone) continue;

          if (env.TERMII_API_KEY) {
            const smsProvider = createSmsProvider(env.TERMII_API_KEY);
            await smsProvider.sendOtp(
              custRow.phone,
              `Good news! ${productName} is back in stock. Shop now: ${storeUrl}`,
              'whatsapp',
            ).catch(() => {});
            notifiedCount++;
          }
        } catch { /* non-fatal per customer */ }
      }

      // 3. Audit log
      await env.DB.prepare(
        'INSERT OR IGNORE INTO inventory_sync_log (id, tenantId, productId, newQuantity, wishlistNotified, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(
        `isl_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        tenantId, productId, newQuantity, notifiedCount, new Date().toISOString()
      ).run().catch(() => {});
    } catch (err) {
      console.error('[handleInventoryUpdated] back-in-stock error:', err);
    }
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

  // Distinguish provider network error from genuine verification failure
  const bvnProviderError = bvnSettled.status === 'rejected';
  const bvnResult = bvnSettled.status === 'fulfilled'
    ? bvnSettled.value
    : { verified: false, reason: 'provider_error', provider: 'smile_identity' };
  const cacResult = cacSettled.status === 'fulfilled'
    ? cacSettled.value
    : { verified: false, reason: 'provider_error', provider: 'prembly' };

  const bvnVerified = bvnResult.verified;
  const cacVerified = cacResult.verified;

  // ── 7. Determine outcome ──────────────────────────────────────────────────
  // CRITICAL: provider network errors → MANUAL_REVIEW (never auto-reject on error)
  let newStatus: KycQueueStatus;
  if (bvnProviderError) {
    // KYC provider unreachable — cannot make automated decision
    newStatus = 'MANUAL_REVIEW';
  } else if (bvnVerified && cacVerified) {
    newStatus = 'AUTO_APPROVED';
  } else if (!bvnVerified) {
    newStatus = 'AUTO_REJECTED';
  } else {
    // bvnVerified && !cacVerified — BVN passed, CAC needs manual review
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
    // MANUAL_REVIEW — BVN passed but CAC needs review, OR provider was unavailable
    const vendorMsg = bvnProviderError
      ? 'Your seller application requires manual review. Our team will contact you within 48 hours.'
      : 'Your BVN has been verified. Your CAC business registration is under manual review. We will notify you within 48 hours.';

    // WhatsApp to vendor
    await _sendKycWhatsApp(env, vendor.phone, vendorMsg);

    // SMS to marketplace admin (ADMIN_PHONE env binding, non-fatal if not configured)
    if (env.ADMIN_PHONE && env.TERMII_API_KEY) {
      try {
        const sms = createSmsProvider(env.TERMII_API_KEY);
        const reason = bvnProviderError ? 'KYC provider unavailable' : 'CAC verification requires review';
        await sms.sendOtp(
          env.ADMIN_PHONE,
          `[WebWaka KYC] Vendor ${vendorId} (${vendor.name}) requires MANUAL REVIEW. Reason: ${reason}. Tenant: ${tenantId}`,
          'sms',
        );
      } catch { /* non-fatal */ }
    }
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

// ─── Handler: cart.abandoned → send WhatsApp nudge via Termii ────────────────

export async function handleCartAbandoned(
  event: WebWakaEvent<{
    customerPhone?: string;
    items?: Array<{ name: string }>;
    cartId?: string;
    cartUrl?: string;
    promoCode?: string;
    isSecondNudge?: boolean;
    tenantId?: string;
  }>,
  env: Env,
): Promise<void> {
  const { customerPhone, items, cartId, cartUrl, promoCode, isSecondNudge } = event.payload;
  if (!customerPhone || !cartId) return;

  const itemList = items ?? [];
  const first3 = itemList.slice(0, 3).map((i) => i.name);
  const remainder = itemList.length - 3;
  const itemSummary = remainder > 0
    ? `${first3.join(', ')} +${remainder} more`
    : first3.join(', ');

  const message = isSecondNudge
    ? `Still thinking? Here's 10% off your order: ${promoCode ?? ''}. Shop now: ${cartUrl ?? ''}`
    : `You left ${itemSummary} in your cart. Complete your order: ${cartUrl ?? ''}`;

  if (env.TERMII_API_KEY) {
    try {
      const sms = createSmsProvider(env.TERMII_API_KEY);
      await sms.sendOtp(customerPhone, message, 'whatsapp');
    } catch { /* Non-fatal — SMS failure must not block event processing */ }
  }

  const now = Date.now();
  const acId = `ac_${now}_${cartId}`;

  try {
    if (isSecondNudge) {
      await env.DB.prepare(
        `UPDATE abandoned_carts SET second_nudge_sent_at = ? WHERE cart_token = (
           SELECT session_token FROM cart_sessions WHERE id = ? LIMIT 1
         )`,
      ).bind(now, cartId).run();
    } else {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO abandoned_carts
           (id, tenant_id, customer_phone, cart_json, total_kobo, nudge_sent_at, cart_token, created_at, updated_at)
         SELECT ?, ?, ?, items_json, 0, ?, session_token, ?, ?
         FROM cart_sessions WHERE id = ?`,
      ).bind(acId, event.tenantId, customerPhone, now, now, now, cartId).run();
    }
  } catch { /* Non-fatal */ }
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
    const storeUrl = `https://${tenantId}.webwaka.ng`;
    const messageMap: Record<string, string> = {
      PICKED_UP: `Your order #${orderId} has been picked up. Track it here: ${trackingUrl ?? `${storeUrl}/track/${orderId}`}`,
      IN_TRANSIT: `Your order is in transit. Estimated arrival: ${estimatedDelivery ?? 'soon'}`,
      OUT_FOR_DELIVERY: 'Your order is out for delivery today! Please be available.',
      DELIVERED: `Your order has been delivered! Enjoyed your purchase? Leave a review: ${storeUrl}/reviews/${orderId}`,
      FAILED: `Delivery attempt failed for order #${orderId}. We will retry. Contact us if you need help.`,
      RETURNED: `Your order #${orderId} was returned. A refund will be processed within 3-5 business days.`,
    };
    const message = messageMap[status];
    if (message) {
      try {
        const sms = createSmsProvider(env.TERMII_API_KEY);
        await sms.sendOtp(customerPhone, message, 'whatsapp');
      } catch { /* non-fatal: SMS failure must not block order processing */ }
    }
  }

  // 4. Queue review invite 3 days after delivery (SV-E07)
  if (mappedStatus === 'DELIVERED') {
    try {
      const existing = await env.DB.prepare(
        `SELECT id FROM review_invites WHERE order_id = ? AND customer_phone = ?`,
      ).bind(orderId, customerPhone ?? '').first();

      if (!existing && customerPhone) {
        const inviteId = `ri_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sendAt = Date.now() + 3 * 24 * 60 * 60 * 1000; // 3 days later
        await env.DB.prepare(
          `INSERT OR IGNORE INTO review_invites
             (id, tenant_id, order_id, customer_phone, send_at, sent, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
        ).bind(inviteId, tenantId, orderId, customerPhone, sendAt, Date.now()).run();
      }
    } catch { /* Non-fatal */ }
  }

  // 5. Invalidate order KV cache
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

  registerHandler(CommerceEvents.CART_ABANDONED, (event) =>
    handleCartAbandoned(event as WebWakaEvent<{
      customerPhone?: string;
      items?: Array<{ name: string }>;
      cartId?: string;
      cartUrl?: string;
      promoCode?: string;
      isSecondNudge?: boolean;
      tenantId?: string;
    }>, env),
  );
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
