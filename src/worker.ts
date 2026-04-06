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
import { b2bRouter } from './modules/b2b/api';
import { recommendationsRouter } from './modules/ai/recommendations';
import { forecastingRouter } from './modules/ai/forecasting';
import { commerceRouter } from './modules/commerce/api';
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
  AI_PLATFORM_URL?: string;             // AI Platform URL (alias for OpenRouter base URL)
  AI_PLATFORM_TOKEN?: string;           // AI Platform token (alias for OPENROUTER_API_KEY)
  CF_IMAGES_ACCOUNT_HASH?: string;
  KYCSALT?: string;                     // KYC BVN/NIN hashing salt (P3-T03)
  ADMIN_API_KEY?: string;               // Internal admin API key for admin endpoints
  SMILE_IDENTITY_PARTNER_ID?: string;   // Smile Identity partner_id (P09 KYC)
  SMILE_IDENTITY_API_KEY?: string;      // Smile Identity api_key (P09 KYC)
  PREMBLY_API_KEY?: string;             // Prembly x-api-key (P09 CAC)
  PREMBLY_APP_ID?: string;              // Prembly app-id (P09 CAC)
  ADMIN_PHONE?: string;                 // Marketplace admin WhatsApp/SMS for MANUAL_REVIEW alerts (P09)
  ASSETS?: Fetcher;                     // CF Pages static assets binding for SPA pass-through (P13-T03)
  CENTRAL_MGMT_URL?: string;            // Central Management service URL for ledger events (P10.1)
  INTER_SERVICE_SECRET?: string;        // Shared secret for inter-service authentication (P10.1)
  LOGISTICS_WORKER?: Fetcher;           // Service Binding to webwaka-logistics (T-CVC-01, T-CVC-02)
  TRACKING_SECRET?: string;             // HMAC-SHA256 secret for signing tracking tokens (T-CVC-02)
  UI_CONFIG_KV?: KVNamespace;           // Canonical branding config store (COM-5, shared with webwaka-ui-builder)
}

const app = new Hono<{ Bindings: Env }>();

// ── CORS ─────────────────────────────────────────────────────────────────────
// P0-T08: dynamic origin allowlist from env (replaced '*' hardcode)
// BUG-03 FIX (T-FND-03 QA): CORS is scoped to /api/*, /health, and /sitemap.xml only.
// /internal/* routes are intentionally excluded — they are reachable exclusively
// via Cloudflare Service Binding and must never be exposed to browser origins.
const corsMiddleware = cors({
  origin: (origin, c) => {
    const allowed = (c.env?.ALLOWED_ORIGINS ?? '*').split(',').map((s: string) => s.trim());
    if (allowed.includes('*')) return origin; // dev mode / unconfigured
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
  credentials: true,
});
app.use('/api/*', corsMiddleware);
app.use('/health', corsMiddleware);
app.use('/sitemap.xml', corsMiddleware);
app.use('/webhooks/*', corsMiddleware);

// ── Health check (public — no auth required) ─────────────────────────────────
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env?.DB ? 'production' : 'development',
      version: '4.2.0',
      modules: ['pos', 'single-vendor', 'multi-vendor', 'b2b', 'ai', 'commerce'],
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
app.route('/api/b2b', b2bRouter);
app.route('/api/ai/recommendations', recommendationsRouter);
app.route('/api/ai/forecasting', forecastingRouter);
app.route('/api/commerce', commerceRouter);
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

// ── SV-E15: OG Meta Edge Rendering for Social Sharing ────────────────────────
// Intercepts bot/crawler requests to /products/:slug and returns OG meta HTML.
// Must be registered BEFORE the notFound handler.
app.get('/products/:slug', async (c) => {
  const ua = c.req.header('User-Agent') ?? '';
  const isCrawler = /bot|crawl|slurp|spider|facebookexternalhit|whatsapp|telegram/i.test(ua);

  if (!isCrawler) {
    // Pass non-bot requests through to the SPA static assets handler (CF Pages ASSETS binding).
    // If ASSETS is not configured (dev mode), serve a minimal redirect to the SPA root.
    if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
    return c.html(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><script>window.location.replace('/');</script></head><body></body></html>`);
  }

  const tenantId = c.req.header('x-tenant-id') ?? 'tnt_demo';
  const slug = c.req.param('slug');

  try {
    const product = await c.env.DB.prepare(
      `SELECT name, description, image_url AS imageUrl, price_kobo AS priceKobo
       FROM products WHERE slug = ? AND tenant_id = ? AND deleted_at IS NULL LIMIT 1`,
    ).bind(slug, tenantId).first<{ name: string; description: string | null; imageUrl: string | null; priceKobo: number }>();

    if (!product) return c.notFound();

    const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const desc = esc(product.description?.substring(0, 150));
    const url = c.req.url;

    return c.html(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<title>${esc(product.name)}</title>
<meta property="og:title" content="${esc(product.name)}" />
<meta property="og:description" content="${desc}" />
<meta property="og:image" content="${esc(product.imageUrl ?? '')}" />
<meta property="og:url" content="${esc(url)}" />
<meta property="og:type" content="product" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(product.name)}" />
<meta name="twitter:description" content="${desc}" />
<meta name="twitter:image" content="${esc(product.imageUrl ?? '')}" />
<meta name="description" content="${desc}" />
</head><body>
<script>window.location.replace(${JSON.stringify(url)});</script>
</body></html>`);
  } catch {
    return c.notFound();
  }
});

// ── POS-E12: Paystack Bank Transfer Webhook ───────────────────────────────────
// Validates HMAC-SHA512 signature; auto-confirms transfer payment legs.
app.post('/webhooks/paystack', async (c) => {
  const secret = c.env.PAYSTACK_SECRET;
  if (!secret) return c.json({ received: true }, 200); // no secret = passthrough in dev

  const signature = c.req.header('x-paystack-signature') ?? '';
  const rawBody = await c.req.text();

  // Validate HMAC-SHA512
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== signature) {
      return c.json({ error: 'Invalid signature' }, 401);
    }
  } catch {
    return c.json({ error: 'Signature validation failed' }, 400);
  }

  let payload: { event?: string; data?: { reference?: string; channel?: string; status?: string } };
  try { payload = JSON.parse(rawBody); } catch { return c.json({ received: true }, 200); }

  if (payload.event === 'charge.success' && payload.data?.channel === 'bank_transfer' && payload.data?.status === 'success') {
    const ref = payload.data.reference;
    if (ref && c.env.DB) {
      try {
        await c.env.DB.prepare(
          `UPDATE order_payment_legs SET status = 'CONFIRMED', updated_at = ?
           WHERE reference = ? AND method = 'transfer' AND status = 'PENDING'`,
        ).bind(Date.now(), ref).run();

        const leg = await c.env.DB.prepare(
          `SELECT order_id FROM order_payment_legs WHERE reference = ? LIMIT 1`,
        ).bind(ref).first<{ order_id: string }>();

        if (leg?.order_id) {
          const pending = await c.env.DB.prepare(
            `SELECT COUNT(*) as cnt FROM order_payment_legs WHERE order_id = ? AND status != 'CONFIRMED'`,
          ).bind(leg.order_id).first<{ cnt: number }>();

          if ((pending?.cnt ?? 1) === 0) {
            await c.env.DB.prepare(
              `UPDATE orders SET order_status = 'COMPLETED', payment_status = 'paid', updated_at = ? WHERE id = ?`,
            ).bind(Date.now(), leg.order_id).run();
          }
        }

        if (c.env.SESSIONS_KV) {
          await c.env.SESSIONS_KV.put(`transfer_confirmed:${ref}`, '1', { expirationTtl: 300 });
        }
      } catch (err) {
        console.error('[webhook/paystack] DB update error:', err);
      }
    }
  }

  return c.json({ received: true }, 200);
});

// ── Internal: Tenant Provisioning (T-FND-03) ────────────────────────────────
// Called exclusively by Super Admin V2 via Cloudflare Service Binding.
// Atomically writes tenant configuration to TENANT_CONFIG KV.
// Security: Validates X-Internal-Secret header against INTER_SERVICE_SECRET env var.
app.post('/internal/provision-tenant', async (c) => {
  // Security gate: reject any call that does not carry the correct inter-service secret.
  // Service Binding calls arrive with no external network exposure, but we still
  // enforce the shared secret for defence-in-depth.
  const internalSecret = c.env.INTER_SERVICE_SECRET
  const providedSecret = c.req.header('X-Internal-Secret')

  if (!internalSecret || providedSecret !== internalSecret) {
    console.error('[PROVISION] Unauthorized internal provisioning attempt')
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const body = await c.req.json() as {
      tenantId: string
      name: string
      type: 'retail' | 'multi_vendor' | 'vendor'
      domain?: string
      currency?: string
      timezone?: string
      modules?: Record<string, unknown>
      syncPreferences?: Record<string, unknown>
      theme?: { primaryColor?: string; logoUrl?: string }
    }

    const { tenantId, name, type, domain, currency, timezone, modules, syncPreferences, theme } = body

    // Validate required fields — strict tenant_id isolation
    if (!tenantId || !name || !type) {
      return c.json(
        { success: false, error: 'Missing required fields: tenantId, name, type' },
        400,
      )
    }

    // BUG-01 FIX (T-FND-03 QA): Build a TenantConfig that exactly matches the interface
    // expected by createTenantResolverMiddleware (src/core/tenant/index.ts).
    // The original implementation used a mismatched schema (id, name, type, modules, etc.)
    // which caused all provisioned tenants to be rejected with 404 on any /api/* route.
    //
    // Canonical TenantConfig fields:
    //   tenantId, domain, enabledModules (string[]), branding, permissions,
    //   featureFlags, inventorySyncPreferences (optional)
    const resolvedModules = modules as Record<string, { enabled?: boolean }> | undefined;
    const enabledModules: string[] = [];
    if (resolvedModules) {
      if (resolvedModules.pos?.enabled !== false) enabledModules.push('retail_pos');
      if (resolvedModules.single_vendor?.enabled !== false) enabledModules.push('single_vendor_storefront');
      if (resolvedModules.multi_vendor?.enabled === true) enabledModules.push('multi_vendor_marketplace');
    } else {
      // Default: enable POS and single-vendor for all tenant types
      enabledModules.push('retail_pos', 'single_vendor_storefront');
      if (type === 'multi_vendor') enabledModules.push('multi_vendor_marketplace');
    }

    const tenantConfig = {
      // Required fields — must match TenantConfig interface exactly
      tenantId,
      domain: domain ?? `${tenantId}.webwaka.app`,
      enabledModules,
      branding: {
        primaryColor: theme?.primaryColor ?? '#2563eb',
        logoUrl: theme?.logoUrl ?? `https://assets.webwaka.com/${tenantId}/logo.png`,
      },
      permissions: {
        admin: ['*'],
        cashier: ['pos.*'],
        customer: ['storefront.*'],
      },
      featureFlags: {
        ai_recommendations: false,
        offline_mode: true,
        loyalty_program: false,
      },
      // Optional fields
      inventorySyncPreferences: (syncPreferences as {
        sync_pos_to_single_vendor: boolean;
        sync_pos_to_multi_vendor: boolean;
        sync_single_vendor_to_multi_vendor: boolean;
        conflict_resolution: 'last_write_wins' | 'manual' | 'version_based';
      } | undefined) ?? {
        sync_pos_to_single_vendor: true,
        sync_pos_to_multi_vendor: false,
        sync_single_vendor_to_multi_vendor: false,
        conflict_resolution: 'last_write_wins' as const,
      },
    };

    // Atomically write tenant configuration to TENANT_CONFIG KV.
    // Key format: `tenant:{tenantId}` — matches createTenantResolverMiddleware lookup.
    await c.env.TENANT_CONFIG.put(`tenant:${tenantId}`, JSON.stringify(tenantConfig))

    console.log(`[PROVISION] Tenant ${tenantId} (${name}) written to TENANT_CONFIG KV`)

    return c.json({ success: true, tenantId, config: tenantConfig }, 201)
  } catch (err) {
    console.error('[PROVISION] Error provisioning tenant:', err)
    return c.json({ success: false, error: 'Internal server error' }, 500)
  }
})

// ── 404 handler ───────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.json(
    {
      success: false,
      error: 'Route not found',
      availableRoutes: [
        '/health', '/api/pos', '/api/single-vendor', '/api/multi-vendor',
        '/api/b2b', '/api/ai/recommendations', '/api/ai/forecasting', '/api/commerce',
      ],
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

    // ── Abandoned cart nudge — second nudge (first nudge > 24 h ago, not converted) ─
    const cutoffSecond = now - 24 * 60 * 60 * 1000; // nudge must have been sent > 24h ago

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
         WHERE cs.customer_phone IS NOT NULL
           AND cs.status != 'COMPLETED'
           AND EXISTS (
             SELECT 1 FROM abandoned_carts ac
             WHERE ac.cart_token = cs.session_token
               AND ac.nudge_sent_at IS NOT NULL
               AND ac.nudge_sent_at < ?
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
          const avgRating = ratingRow?.avg_rating ?? 0.0;
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

    // ── Campaign status transitions (DRAFT→ACTIVE, ACTIVE→ENDED) ─────────────
    // Runs every cron invocation (hourly); uses ISO date strings matching D1 storage.
    try {
      const nowIso = new Date().toISOString();

      const activateResult = await env.DB.prepare(
        `UPDATE marketplace_campaigns
         SET status = 'ACTIVE'
         WHERE startDate <= ? AND endDate > ? AND status = 'DRAFT'`
      ).bind(nowIso, nowIso).run();
      if (activateResult.meta?.changes ?? 0 > 0) {
        console.log(`[cron] Activated ${activateResult.meta?.changes ?? 0} campaign(s)`);
      }

      const endResult = await env.DB.prepare(
        `UPDATE marketplace_campaigns
         SET status = 'ENDED'
         WHERE endDate <= ? AND status = 'ACTIVE'`
      ).bind(nowIso).run();
      if (endResult.meta?.changes ?? 0 > 0) {
        console.log(`[cron] Ended ${endResult.meta?.changes ?? 0} campaign(s)`);
      }
    } catch (err) {
      console.error('[cron] Campaign status transition error:', err);
    }

    // ── Daily vendor analytics snapshot (MV-E15) ──────────────────────────────
    // Aggregates each vendor's daily revenue/orders from orders table.
    // Run daily via cron trigger; idempotent via INSERT OR REPLACE.
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dayStart = new Date(today).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000 - 1;

      const { results: activeVendors } = await env.DB.prepare(
        `SELECT id, marketplace_tenant_id AS tenantId FROM vendors WHERE status = 'active'`
      ).all<{ id: string; tenantId: string }>();

      for (const v of activeVendors ?? []) {
        const row = await env.DB.prepare(
          `SELECT
             COUNT(*)                                AS orderCount,
             COALESCE(SUM(total_amount), 0)          AS revenueKobo,
             COUNT(DISTINCT customer_id)             AS customerCount,
             (SELECT COUNT(DISTINCT customer_id)
              FROM orders
              WHERE vendor_id = ? AND tenant_id = ? AND payment_status = 'paid'
                AND customer_id IN (
                  SELECT customer_id FROM orders
                  WHERE vendor_id = ? AND tenant_id = ? AND payment_status = 'paid'
                    AND created_at < ?
                )
             )                                       AS repeatBuyerCount
           FROM orders
           WHERE vendor_id = ? AND tenant_id = ? AND payment_status = 'paid'
             AND created_at >= ? AND created_at <= ?`
        ).bind(
          v.id, v.tenantId, v.id, v.tenantId, dayStart,
          v.id, v.tenantId, dayStart, dayEnd,
        ).first<{ orderCount: number; revenueKobo: number; customerCount: number; repeatBuyerCount: number }>();

        if (!row) continue;
        const avgOrderValue = row.orderCount > 0 ? Math.round(row.revenueKobo / row.orderCount) : 0;
        const analyticsId = `vda_${v.id}_${today}`;

        await env.DB.prepare(
          `INSERT OR REPLACE INTO vendor_daily_analytics
             (id, vendorId, tenantId, date, revenueKobo, orderCount, avgOrderValueKobo, repeatBuyerCount)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(analyticsId, v.id, v.tenantId, today, row.revenueKobo, row.orderCount, avgOrderValue, row.repeatBuyerCount).run();
      }

      console.log(`[cron] Vendor analytics snapshot complete for ${(activeVendors ?? []).length} vendors on ${today}`);
    } catch (err) {
      console.error('[cron] Vendor analytics error:', err);
    }

    // ── MV-E12: Flash Sales Engine — activate/deactivate based on time windows ──
    try {
      const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const activated = await env.DB.prepare(
        `UPDATE flash_sales SET active = 1 WHERE startTime <= ? AND endTime > ? AND active = 0`,
      ).bind(nowIso, nowIso).run();
      const deactivated = await env.DB.prepare(
        `UPDATE flash_sales SET active = 0 WHERE endTime <= ? AND active = 1`,
      ).bind(nowIso).run();
      if ((activated.meta?.changes ?? 0) > 0 || (deactivated.meta?.changes ?? 0) > 0) {
        console.log(`[cron] Flash sales: activated=${activated.meta?.changes ?? 0} deactivated=${deactivated.meta?.changes ?? 0}`);
      }
      // Invalidate KV cache for products with changed flash sale status
      const affectedProducts = await env.DB.prepare(
        `SELECT DISTINCT productId, tenantId FROM flash_sales WHERE active = 1`,
      ).all<{ productId: string; tenantId: string }>();
      for (const p of affectedProducts.results ?? []) {
        await env.CATALOG_CACHE?.delete(`catalog:${p.tenantId}:product:${p.productId}`).catch(() => {});
      }
    } catch (err) {
      console.error('[cron] Flash sales engine error:', err);
    }

    // ── SV-E14: Subscription Recurring Orders — charge on nextChargeDate ────────
    try {
      const today2 = new Date().toISOString().slice(0, 10);
      const { results: dueSubs } = await env.DB.prepare(
        `SELECT s.id, s.tenantId, s.customerId, s.productId, s.frequencyDays, s.paystackToken,
                s.retryCount, s.productName,
                p.name AS pName, p.price_kobo AS priceKobo,
                c.phone AS customerPhone
         FROM subscriptions s
         LEFT JOIN products p ON p.id = s.productId AND p.tenant_id = s.tenantId
         LEFT JOIN customers c ON c.id = s.customerId AND c.tenant_id = s.tenantId
         WHERE s.status = 'ACTIVE' AND DATE(s.nextChargeDate) <= DATE(?)`,
      ).bind(today2).all<{
        id: string; tenantId: string; customerId: string; productId: string;
        frequencyDays: number; paystackToken: string; retryCount: number; productName: string | null;
        pName: string | null; priceKobo: number | null; customerPhone: string | null;
      }>();

      for (const sub of dueSubs ?? []) {
        if (!env.PAYSTACK_SECRET) continue;
        const price = sub.priceKobo ?? 0;
        const productName = sub.productName ?? sub.pName ?? 'Product';
        try {
          const chargeRes = await fetch('https://api.paystack.co/transaction/charge_authorization', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ authorization_code: sub.paystackToken, email: `sub_${sub.customerId}@webwaka.internal`, amount: price }),
          });
          const chargeData = await chargeRes.json() as { status: boolean; data?: { status: string; reference: string } };

          if (chargeData.status && chargeData.data?.status === 'success') {
            // Create order
            const orderId = `ord_sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const nextCharge = new Date();
            nextCharge.setDate(nextCharge.getDate() + sub.frequencyDays);
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO orders (id, tenant_id, customer_id, total_amount, payment_method, payment_status, order_status, payment_reference, created_at)
                 VALUES (?, ?, ?, ?, 'subscription', 'paid', 'PROCESSING', ?, ?)`,
              ).bind(orderId, sub.tenantId, sub.customerId, price, chargeData.data.reference, Date.now()),
              env.DB.prepare(
                `UPDATE subscriptions SET nextChargeDate = ?, retryCount = 0 WHERE id = ?`,
              ).bind(nextCharge.toISOString().slice(0, 10), sub.id),
            ]);
            console.log(`[cron] Subscription ${sub.id} charged OK — next: ${nextCharge.toISOString().slice(0, 10)}`);
          } else {
            const newRetry = (sub.retryCount ?? 0) + 1;
            if (newRetry >= 3) {
              await env.DB.prepare(
                `UPDATE subscriptions SET status = 'CANCELLED', retryCount = ?, lastFailedAt = ? WHERE id = ?`,
              ).bind(newRetry, new Date().toISOString(), sub.id).run();
              // Send WhatsApp cancellation notice
              if (sub.customerPhone && env.TERMII_API_KEY) {
                const sms = createSmsProvider(env.TERMII_API_KEY, 'WebWaka');
                await sms.sendMessage(sub.customerPhone, `Your subscription for ${productName} has been cancelled due to payment failure. Please update your payment method at webwaka.shop.`).catch(() => {});
              }
              console.log(`[cron] Subscription ${sub.id} cancelled after 3 failed charges`);
            } else {
              await env.DB.prepare(
                `UPDATE subscriptions SET retryCount = ?, lastFailedAt = ? WHERE id = ?`,
              ).bind(newRetry, new Date().toISOString(), sub.id).run();
              console.log(`[cron] Subscription ${sub.id} charge failed (retry ${newRetry}/3)`);
            }
          }
        } catch (subErr) {
          console.error(`[cron] Subscription ${sub.id} charge error:`, subErr);
        }
      }
    } catch (err) {
      console.error('[cron] Subscription charging error:', err);
    }
  },
};
