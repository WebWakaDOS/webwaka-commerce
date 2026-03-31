/// <reference types="@cloudflare/workers-types" />
/**
 * WebWaka Commerce Suite - Unified Cloudflare Worker Entry Point
 * Mounts all Commerce modules: POS, Single-Vendor, Multi-Vendor
 * Invariant compliance: Multi-tenancy, Nigeria-First, Offline-First
 *
 * Security: All /api/* routes require JWT Bearer token (stored in SESSIONS_KV).
 * Replaces insecure x-tenant-id header-only authentication.
 * Public exceptions: GET /health, GET /api/pos/products,
 *                    GET /api/single-vendor/products, GET /api/multi-vendor/products
 *
 * Event Bus: CF Queues (COMMERCE_EVENTS binding).
 * See src/core/event-bus/index.ts for publishEvent() usage in route handlers.
 * See src/core/event-bus/handlers/index.ts for consumer dispatch logic.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { posRouter } from './modules/pos/api';
import { singleVendorRouter } from './modules/single-vendor/api';
import { multiVendorRouter } from './modules/multi-vendor/api';
import { jwtAuthMiddleware } from './middleware/auth';
import { createTenantResolverMiddleware } from './core/tenant/index';
import { syncRouter } from './core/sync/server';
import { dispatchEvent, type WebWakaEvent, publishEvent } from './core/event-bus/index';
import { registerAllHandlers } from './core/event-bus/handlers/index';
import { CommerceEvents, createSmsProvider } from '@webwaka/core';

export interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  EVENTS: KVNamespace;
  SESSIONS_KV: KVNamespace;
  CATALOG_CACHE: KVNamespace;
  COMMERCE_EVENTS: Queue<WebWakaEvent>;  // CF Queues — event bus (producer + consumer)
  PAYSTACK_SECRET: string;
  TERMII_API_KEY: string;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;             // Comma-separated origin allowlist (P0-T08)
  OPENROUTER_API_KEY?: string;          // OpenRouter AI API key (P5-T03)
  CF_IMAGES_ACCOUNT_HASH?: string;
  KYCSALT?: string;                     // KYC BVN/NIN hashing salt (P3-T03)
  ADMIN_API_KEY?: string;               // Internal admin API key for admin endpoints
  SMILE_IDENTITY_PARTNER_ID?: string;   // Smile Identity partner_id (P09 KYC)
  SMILE_IDENTITY_API_KEY?: string;      // Smile Identity api_key (P09 KYC)
  PREMBLY_API_KEY?: string;             // Prembly x-api-key (P09 CAC)
  PREMBLY_APP_ID?: string;              // Prembly app-id (P09 CAC)
  ADMIN_PHONE?: string;                 // Marketplace admin WhatsApp/SMS for MANUAL_REVIEW alerts (P09)
}

const app = new Hono<{ Bindings: Env }>();

// ── CORS ─────────────────────────────────────────────────────────────────────
// P0-T08: dynamic origin allowlist from env (replaced '*' hardcode)
app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env?.ALLOWED_ORIGINS ?? '*').split(',').map((s: string) => s.trim());
    if (allowed.includes('*')) return origin; // dev mode / unconfigured
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
  credentials: true,
}));

// ── Health check (public — no auth required) ─────────────────────────────────
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env?.DB ? 'production' : 'development',
      version: '4.2.0',
      modules: ['pos', 'single-vendor', 'multi-vendor'],
      security: 'JWT-auth-enabled',
      event_bus: 'cloudflare-queues',
      timestamp: new Date().toISOString(),
    },
  });
});

// ── JWT auth middleware — protects all /api/* routes ─────────────────────────
app.use('/api/*', jwtAuthMiddleware);

// ── Tenant resolver — resolves and validates tenant from TENANT_CONFIG KV (P0-T07) ──
app.use('/api/*', (c, next) => createTenantResolverMiddleware(c.env.TENANT_CONFIG)(c, next));

// ── Commerce modules ──────────────────────────────────────────────────────────
app.route('/api/pos', posRouter);
app.route('/api/single-vendor', singleVendorRouter);
app.route('/api/multi-vendor', multiVendorRouter);
app.route('/api/sync', syncRouter);

// ── GET /sitemap.xml — Product sitemap for SEO (P2-T08) ──────────────────────
// Tenant ID defaults to "tnt_demo"; in production, this is KV-resolved.
app.get('/sitemap.xml', async (c) => {
  const tenantId = c.req.header('x-tenant-id') ?? 'tnt_demo';
  const baseUrl = `https://${c.req.header('host') ?? 'webwaka.shop'}`;

  try {
    const KV_KEY = `sitemap:${tenantId}`;
    // Serve from KV cache (24h TTL) if available
    if (c.env.CATALOG_CACHE) {
      const cached = await c.env.CATALOG_CACHE.get(KV_KEY);
      if (cached) {
        return new Response(cached, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
        });
      }
    }

    const { results } = await c.env.DB.prepare(
      `SELECT slug, id, updated_at FROM products
       WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 1000`,
    ).bind(tenantId).all<{ slug: string | null; id: string; updated_at: number }>();

    const urls = results.map((p) => {
      const path = p.slug ? `/products/${p.slug}` : `/products/${p.id}`;
      const lastmod = new Date(p.updated_at).toISOString().split('T')[0];
      return `  <url>\n    <loc>${baseUrl}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`;
    });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
${urls.join('\n')}
</urlset>`;

    // Cache for 24h
    if (c.env.CATALOG_CACHE) {
      c.executionCtx?.waitUntil(
        c.env.CATALOG_CACHE.put(KV_KEY, xml, { expirationTtl: 86400 }),
      );
    }

    return new Response(xml, {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    // Fallback minimal sitemap
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${baseUrl}/</loc></url>\n</urlset>`;
    return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Route not found',
      availableRoutes: ['/health', '/api/pos', '/api/single-vendor', '/api/multi-vendor'],
    },
    404,
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// ─────────────────────────────────────────────────────────────────────────────
// Worker Exports
// ─────────────────────────────────────────────────────────────────────────────
export default {
  // ── HTTP fetch handler ────────────────────────────────────────────────────
  fetch: app.fetch.bind(app),

  // ── CF Queue consumer: COMMERCE_EVENTS ───────────────────────────────────
  // Invoked when a message batch is delivered from the Cloudflare Queue.
  // Each message is a WebWakaEvent. Handlers are registered in
  // src/core/event-bus/handlers/index.ts via registerAllHandlers().
  async queue(
    batch: MessageBatch<WebWakaEvent>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    registerAllHandlers(env); // idempotent — registers once per isolate

    for (const msg of batch.messages) {
      try {
        await dispatchEvent(msg.body);
        msg.ack();
      } catch (err) {
        console.error(`Event dispatch failed [${msg.body?.type}]:`, err);
        msg.retry(); // CF Queues will re-deliver on retry
      }
    }
  },

  // ── Scheduled cron handler ────────────────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();

    // ── T+7 Settlement Release: held → eligible ─────────────────────────────
    // Runs every cron invocation; finds settlements whose hold period has expired
    // and marks them as 'eligible' so vendors can request payout.
    try {
      const { results: heldSettlements } = await env.DB.prepare(
        `SELECT id, tenant_id, vendor_id
         FROM settlements
         WHERE status = 'held' AND hold_until <= ?
         LIMIT 200`,
      ).bind(now).all<{ id: string; tenant_id: string; vendor_id: string }>();

      if (heldSettlements.length > 0) {
        // Batch update in groups of 50 to avoid D1 batch limits
        const BATCH_SIZE = 50;
        for (let i = 0; i < heldSettlements.length; i += BATCH_SIZE) {
          const chunk = heldSettlements.slice(i, i + BATCH_SIZE);
          await env.DB.batch(
            chunk.map(s =>
              env.DB.prepare(
                `UPDATE settlements
                 SET status = 'eligible', updated_at = ?
                 WHERE id = ? AND status = 'held'`,
              ).bind(now, s.id),
            ),
          );
        }
        console.log(`[cron] Released ${heldSettlements.length} settlements to eligible`);
      }
    } catch (err) {
      console.error('[cron] Settlement release error:', err);
    }

    // ── Auto payout-request: create pending requests for vendors ────────────
    // For each vendor+tenant that has eligible settlements and no pending payout
    // request, automatically create a payout_request and release the settlements.
    try {
      interface VendorEligible { vendor_id: string; tenant_id: string; total: number; count: number }
      const { results: eligibleGroups } = await env.DB.prepare(
        `SELECT vendor_id, tenant_id, SUM(amount) AS total, COUNT(*) AS count
         FROM settlements
         WHERE status = 'eligible' AND payout_request_id IS NULL
         GROUP BY vendor_id, tenant_id
         LIMIT 20`,
      ).bind().all<VendorEligible>();

      for (const group of eligibleGroups) {
        // Skip if a payout request is already pending for this vendor
        const existing = await env.DB.prepare(
          `SELECT id FROM payout_requests
           WHERE vendor_id = ? AND tenant_id = ? AND status IN ('pending', 'processing')
           LIMIT 1`,
        ).bind(group.vendor_id, group.tenant_id).first<{ id: string }>();
        if (existing) continue;

        // Get settlement IDs to release
        const { results: stls } = await env.DB.prepare(
          `SELECT id FROM settlements
           WHERE vendor_id = ? AND tenant_id = ? AND status = 'eligible' AND payout_request_id IS NULL`,
        ).bind(group.vendor_id, group.tenant_id).all<{ id: string }>();
        if (!stls.length) continue;

        const prId = `pr_auto_${now}_${group.vendor_id.slice(-6)}`;
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO payout_requests
               (id, tenant_id, vendor_id, amount, settlement_count, bank_details_json,
                status, requested_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?, ?)`,
          ).bind(prId, group.tenant_id, group.vendor_id, group.total, stls.length, now, now, now),
          ...stls.map(s =>
            env.DB.prepare(
              `UPDATE settlements SET status = 'released', payout_request_id = ?, updated_at = ?
               WHERE id = ?`,
            ).bind(prId, now, s.id),
          ),
        ]);
        console.log(`[cron] Auto payout ${prId} for vendor ${group.vendor_id}: ₦${(group.total / 100).toFixed(2)}`);
      }
    } catch (err) {
      console.error('[cron] Auto payout-request error:', err);
    }

    // ── Abandoned cart nudge — first nudge (> 60 min, nudgedAt IS NULL) ────────
    const cutoffFirst = now - 60 * 60 * 1000; // 1 hour ago

    try {
      interface CartSession {
        id: string;
        tenant_id: string;
        session_token: string;
        items_json: string;
        customer_phone?: string;
        created_at: number;
      }

      const { results: firstNudgeCarts } = await env.DB.prepare(
        `SELECT cs.id, cs.tenant_id, cs.session_token, cs.items_json, cs.customer_phone, cs.created_at
         FROM cart_sessions cs
         WHERE cs.created_at < ? AND cs.customer_phone IS NOT NULL
           AND cs.status != 'COMPLETED'
           AND NOT EXISTS (
             SELECT 1 FROM abandoned_carts ac
             WHERE ac.cart_token = cs.session_token AND ac.nudge_sent_at IS NOT NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM orders o
             WHERE o.customer_phone = cs.customer_phone
               AND o.created_at > cs.created_at
               AND o.channel = 'storefront'
           )
         LIMIT 50`,
      ).bind(cutoffFirst).all<CartSession>();

      for (const cart of firstNudgeCarts) {
        let items: Array<{ name: string; price: number; quantity: number }> = [];
        try { items = JSON.parse(cart.items_json ?? '[]'); } catch { continue; }
        if (!items.length) continue;

        const cartUrl = `https://webwaka.shop/${cart.tenant_id}/checkout?cart=${cart.session_token}`;

        await publishEvent(env.COMMERCE_EVENTS, {
          id: `evt_cart_abandoned_${now}_${cart.id}`,
          tenantId: cart.tenant_id,
          type: CommerceEvents.CART_ABANDONED,
          sourceModule: 'worker_cron',
          timestamp: now,
          payload: {
            customerPhone: cart.customer_phone,
            items,
            tenantId: cart.tenant_id,
            cartId: cart.id,
            cartUrl,
            isSecondNudge: false,
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[cron] First abandoned cart nudge error:', err);
    }

    // ── Abandoned cart nudge — second nudge (> 24 h, already nudged once) ────
    const cutoffSecond = now - 24 * 60 * 60 * 1000; // 24 hours ago

    try {
      interface CartSessionWithAc {
        id: string;
        tenant_id: string;
        session_token: string;
        items_json: string;
        customer_phone?: string;
        created_at: number;
      }

      const { results: secondNudgeCarts } = await env.DB.prepare(
        `SELECT cs.id, cs.tenant_id, cs.session_token, cs.items_json, cs.customer_phone, cs.created_at
         FROM cart_sessions cs
         WHERE cs.created_at < ? AND cs.customer_phone IS NOT NULL
           AND cs.status != 'COMPLETED'
           AND EXISTS (
             SELECT 1 FROM abandoned_carts ac
             WHERE ac.cart_token = cs.session_token AND ac.nudge_sent_at IS NOT NULL
               AND ac.second_nudge_sent_at IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM orders o
             WHERE o.customer_phone = cs.customer_phone
               AND o.created_at > cs.created_at
               AND o.channel = 'storefront'
           )
         LIMIT 50`,
      ).bind(cutoffSecond).all<CartSessionWithAc>();

      for (const cart of secondNudgeCarts) {
        let items: Array<{ name: string; price: number; quantity: number }> = [];
        try { items = JSON.parse(cart.items_json ?? '[]'); } catch { continue; }
        if (!items.length) continue;

        const cartUrl = `https://webwaka.shop/${cart.tenant_id}/checkout?cart=${cart.session_token}`;

        let promoCode: string | null = null;
        try {
          const existingPromo = await env.DB.prepare(
            `SELECT code FROM promo_codes
             WHERE tenant_id = ? AND discount_type = 'pct' AND discount_value = 10
               AND is_active = 1 AND (expires_at IS NULL OR expires_at > ?)
               AND deleted_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          ).bind(cart.tenant_id, now).first<{ code: string }>();

          if (existingPromo) {
            promoCode = existingPromo.code;
          } else {
            promoCode = `COMEBACK10_${cart.tenant_id.slice(-6).toUpperCase()}`;
            const promoId = `promo_auto_${now}_${Math.random().toString(36).slice(2, 8)}`;
            await env.DB.prepare(
              `INSERT OR IGNORE INTO promo_codes
                 (id, tenant_id, code, discount_type, discount_value, min_order_kobo,
                  max_uses, current_uses, is_active, created_at, updated_at)
               VALUES (?, ?, ?, 'pct', 10, 0, 1000, 0, 1, ?, ?)`,
            ).bind(promoId, cart.tenant_id, promoCode, now, now).run();
          }
        } catch {
          promoCode = null;
        }

        await publishEvent(env.COMMERCE_EVENTS, {
          id: `evt_cart_abandoned2_${now}_${cart.id}`,
          tenantId: cart.tenant_id,
          type: CommerceEvents.CART_ABANDONED,
          sourceModule: 'worker_cron',
          timestamp: now,
          payload: {
            customerPhone: cart.customer_phone,
            items,
            tenantId: cart.tenant_id,
            cartId: cart.id,
            cartUrl,
            promoCode,
            isSecondNudge: true,
          },
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[cron] Second abandoned cart nudge error:', err);
    }

    // ── Review invites: send WhatsApp 3 days after delivery ──────────────────
    try {
      interface ReviewInvite {
        id: string;
        tenant_id: string;
        customer_phone: string;
        order_id: string;
      }

      const { results: invites } = await env.DB.prepare(
        `SELECT id, tenant_id, customer_phone, order_id
         FROM review_invites
         WHERE send_at <= ? AND sent = 0
         LIMIT 100`,
      ).bind(now).all<ReviewInvite>();

      for (const invite of invites) {
        try {
          if (env.TERMII_API_KEY) {
            const sms = createSmsProvider(env.TERMII_API_KEY);
            await sms.sendOtp(
              invite.customer_phone,
              `How was your order? Leave a review and help other shoppers: https://webwaka.shop/${invite.tenant_id}/orders/${invite.order_id}/review`,
              'whatsapp',
            );
          }
          await env.DB.prepare(
            `UPDATE review_invites SET sent = 1, sent_at = ? WHERE id = ?`,
          ).bind(now, invite.id).run();
        } catch {
          // Non-fatal — will retry on next cron run
        }
      }
    } catch (err) {
      console.error('[cron] Review invites error:', err);
    }

    // ── Weekly vendor performance scoring ────────────────────────────────────
    // Runs every invocation but uses a lightweight 7-day lookback window.
    // Configure wrangler.toml cron trigger to run on Sundays: "0 0 * * 0"
    try {
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

      interface ActiveVendor { id: string; marketplace_tenant_id: string; phone: string | null }
      const { results: vendors } = await env.DB.prepare(
        `SELECT id, marketplace_tenant_id, phone
         FROM vendors
         WHERE status = 'active' AND deleted_at IS NULL
         LIMIT 200`,
      ).bind().all<ActiveVendor>();

      for (const vendor of vendors) {
        try {
          const tenantId = vendor.marketplace_tenant_id;

          const orderStats = await env.DB.prepare(
            `SELECT
               COUNT(*) AS total_orders,
               SUM(CASE WHEN order_status = 'DELIVERED' THEN 1 ELSE 0 END) AS delivered_orders
             FROM orders
             WHERE vendor_id = ? AND tenant_id = ? AND created_at >= ?`,
          ).bind(vendor.id, tenantId, thirtyDaysAgo).first<{ total_orders: number; delivered_orders: number }>();

          const ratingRow = await env.DB.prepare(
            `SELECT AVG(pr.rating) AS avg_rating
             FROM product_reviews pr
             JOIN products p ON p.id = pr.product_id
             WHERE p.vendor_id = ? AND pr.tenant_id = ? AND pr.created_at >= ?
               AND pr.status = 'APPROVED'`,
          ).bind(vendor.id, tenantId, thirtyDaysAgo).first<{ avg_rating: number | null }>();

          const disputeRow = await env.DB.prepare(
            `SELECT COUNT(*) AS dispute_count
             FROM disputes
             WHERE tenant_id = ? AND order_id IN (
               SELECT id FROM orders WHERE vendor_id = ? AND tenant_id = ? AND created_at >= ?
             )`,
          ).bind(tenantId, vendor.id, tenantId, thirtyDaysAgo).first<{ dispute_count: number }>();

          const totalOrders = orderStats?.total_orders ?? 0;
          const deliveredOrders = orderStats?.delivered_orders ?? 0;
          const fulfillmentRate = totalOrders > 0 ? deliveredOrders / totalOrders : 0;
          const avgRating = ratingRow?.avg_rating ?? 4.0;
          const disputeCount = disputeRow?.dispute_count ?? 0;
          const disputeRate = totalOrders > 0 ? disputeCount / totalOrders : 0;

          const score = Math.round(
            fulfillmentRate * 40 +
            (avgRating / 5) * 20 +
            (1 - disputeRate) * 30 +
            10,
          );

          let badge: string | null = null;
          if (score >= 90) badge = 'TOP_SELLER';
          else if (score >= 75) badge = 'VERIFIED';
          else if (score >= 60) badge = 'TRUSTED';

          await env.DB.prepare(
            `UPDATE vendors SET performanceScore = ?, badge = ?, scoreUpdatedAt = ? WHERE id = ?`,
          ).bind(score, badge, new Date(now).toISOString(), vendor.id).run();

          if (score < 40 && vendor.phone && env.TERMII_API_KEY) {
            const sms = createSmsProvider(env.TERMII_API_KEY);
            await sms.sendOtp(
              vendor.phone,
              `Your WebWaka store performance score is ${score}/100. To improve: fulfil orders faster (${Math.round(fulfillmentRate * 100)}% rate), resolve disputes promptly, and encourage customer reviews. Contact support for help.`,
              'whatsapp',
            ).catch(() => {});
          }
        } catch {
          // Non-fatal per vendor — skip and continue
        }
      }
      console.log(`[cron] Vendor scoring complete for ${vendors.length} vendors`);
    } catch (err) {
      console.error('[cron] Vendor scoring error:', err);
    }
  },
};
