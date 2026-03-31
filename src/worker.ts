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
import { dispatchEvent, type WebWakaEvent } from './core/event-bus/index';
import { registerAllHandlers } from './core/event-bus/handlers/index';
import { sendTermiiSms } from '@webwaka/core';

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

    // ── Abandoned cart nudge ─────────────────────────────────────────────────
    const nudgeAfterMs = 60 * 60 * 1000; // 1 hour
    const cutoff = now - nudgeAfterMs;

    try {
      interface CartSession {
        id: string;
        tenant_id: string;
        session_token: string;
        items_json: string;
        customer_phone?: string;
        created_at: number;
      }

      const { results } = await env.DB.prepare(
        `SELECT cs.id, cs.tenant_id, cs.session_token, cs.items_json, cs.customer_phone, cs.created_at
         FROM cart_sessions cs
         WHERE cs.created_at < ? AND cs.customer_phone IS NOT NULL
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
      )
        .bind(cutoff)
        .all<CartSession>();

      for (const cart of results) {
        let items: Array<{ name: string; price: number; quantity: number }> = [];
        try {
          items = JSON.parse(cart.items_json ?? '[]');
        } catch {
          continue;
        }
        if (!items.length) continue;

        const totalKobo = items.reduce((s, i) => s + i.price * i.quantity, 0);
        const totalNaira = (totalKobo / 100).toLocaleString('en-NG', {
          style: 'currency',
          currency: 'NGN',
        });
        const itemSummary = items
          .slice(0, 3)
          .map((i) => i.name)
          .join(', ');
        const message = `Hi! You left items in your WebWaka cart: ${itemSummary}... worth ${totalNaira}. Complete your order: https://webwaka.shop/${cart.tenant_id}/checkout`;

        await sendTermiiSms({
          to: cart.customer_phone ?? '',
          message,
          apiKey: env.TERMII_API_KEY ?? '',
          channel: 'whatsapp',
        });

        const acId = `ac_${now}_${cart.id}`;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO abandoned_carts
             (id, tenant_id, customer_phone, cart_json, total_kobo, nudge_sent_at, cart_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            acId,
            cart.tenant_id,
            cart.customer_phone ?? null,
            cart.items_json,
            totalKobo,
            now,
            cart.session_token,
            now,
            now,
          )
          .run();
      }
    } catch (err) {
      console.error('Abandoned cart cron error:', err);
    }
  },
};
