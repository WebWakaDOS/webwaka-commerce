/**
 * WebWaka Commerce Suite - Unified Cloudflare Worker Entry Point
 * Mounts all Commerce modules: POS, Single-Vendor, Multi-Vendor
 * Invariant compliance: Multi-tenancy, Nigeria-First, Offline-First
 *
 * Security: All /api/* routes require JWT Bearer token (stored in SESSIONS_KV).
 * Replaces insecure x-tenant-id header-only authentication.
 * Public exceptions: GET /health, GET /api/pos/products,
 *                    GET /api/single-vendor/products, GET /api/multi-vendor/products
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { posRouter } from './modules/pos/api';
import { singleVendorRouter } from './modules/single-vendor/api';
import { multiVendorRouter } from './modules/multi-vendor/api';
import { jwtAuthMiddleware } from './middleware/auth';

export interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  EVENTS: KVNamespace;
  SESSIONS_KV: KVNamespace;
  CATALOG_CACHE: KVNamespace;       // 60-second catalog page cache
  PAYSTACK_SECRET: string;          // Cloudflare Worker secret
  TERMII_API_KEY: string;           // Termii SMS API key for OTP delivery
  JWT_SECRET: string;               // HMAC-SHA256 secret for customer JWTs
  CF_IMAGES_ACCOUNT_HASH?: string;  // Cloudflare Images account hash (optional)
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
}));

// Health check (public — no auth required)
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env?.DB ? 'production' : 'development',
      version: '4.1.0',
      modules: ['pos', 'single-vendor', 'multi-vendor'],
      security: 'JWT-auth-enabled',
      timestamp: new Date().toISOString(),
    }
  });
});

// JWT auth middleware — protects all /api/* routes
// Public sub-routes are whitelisted inside the middleware
app.use('/api/*', jwtAuthMiddleware);

// Mount Commerce modules
app.route('/api/pos', posRouter);
app.route('/api/single-vendor', singleVendorRouter);
app.route('/api/multi-vendor', multiVendorRouter);

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/pos', '/api/single-vendor', '/api/multi-vendor'],
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

export default {
  fetch: app.fetch.bind(app),

  // ── Cron: Abandoned Cart WhatsApp Nudge (runs hourly via wrangler.toml) ───
  // Finds cart_sessions with items that haven't converted to orders in >1h
  // and sends a WhatsApp nudge via Termii if customer_phone is known.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const nudgeAfterMs = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    const cutoff = now - nudgeAfterMs;

    try {
      interface CartSession { id: string; tenant_id: string; session_token: string; items_json: string; customer_phone?: string; created_at: number }
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
             WHERE o.customer_phone = cs.customer_phone AND o.created_at > cs.created_at AND o.channel = 'storefront'
           )
         LIMIT 50`
      ).bind(cutoff).all<CartSession>();

      for (const cart of results) {
        let items: Array<{ name: string; price: number; quantity: number }> = [];
        try { items = JSON.parse(cart.items_json ?? '[]'); } catch { continue; }
        if (!items.length) continue;

        const totalKobo = items.reduce((s, i) => s + i.price * i.quantity, 0);
        const totalNaira = (totalKobo / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
        const itemSummary = items.slice(0, 3).map(i => i.name).join(', ');
        const message = `Hi! You left items in your WebWaka cart: ${itemSummary}... worth ${totalNaira}. Complete your order: https://webwaka.shop/${cart.tenant_id}/checkout`;

        if (env.TERMII_API_KEY) {
          await fetch('https://api.ng.termii.com/api/sms/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              api_key: env.TERMII_API_KEY,
              to: cart.customer_phone,
              from: 'WebWaka',
              sms: message,
              type: 'plain',
              channel: 'whatsapp',
            }),
          });
        }

        const acId = `ac_${now}_${cart.id}`;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO abandoned_carts (id, tenant_id, customer_phone, cart_json, total_kobo, nudge_sent_at, cart_token, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(acId, cart.tenant_id, cart.customer_phone, cart.items_json, totalKobo, now, cart.session_token, now, now).run();
      }
    } catch (err) {
      console.error('Abandoned cart cron error:', err);
    }
  },
};
