/**
 * WebWaka Commerce Suite - Unified Cloudflare Worker Entry Point
 * Mounts all Commerce modules: POS, Single-Vendor, Multi-Vendor
 * Invariant compliance: Multi-tenancy, Nigeria-First, Offline-First
 *
 * Security (hardened 2026-03-29):
 *   - Environment-aware CORS (no wildcard in staging/production)
 *   - JWT_SECRET-based signed JWT verification (replaces KV session lookup)
 *   - JWT_SECRET and RATE_LIMIT_KV bindings required
 */
import { Hono } from 'hono';
import { posRouter } from './modules/pos/api';
import { singleVendorRouter } from './modules/single-vendor/api';
import { multiVendorRouter } from './modules/multi-vendor/api';
import { jwtAuthMiddleware } from './middleware/auth';

export interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  EVENTS: KVNamespace;
  SESSIONS_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// SECURITY: Environment-aware CORS — never wildcard in staging/production
// ============================================================================
const ALLOWED_ORIGINS: Record<string, string[]> = {
  production: [
    'https://commerce.webwaka.app',
    'https://pos.webwaka.app',
    'https://admin.webwaka.app',
  ],
  staging: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://commerce-staging.webwaka.app',
  ],
};

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development';
  const origin = c.req.header('Origin') || '';
  const allowed = ALLOWED_ORIGINS[env];
  const isAllowed = !allowed || allowed.includes(origin);

  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (isAllowed && origin) headers['Access-Control-Allow-Origin'] = origin;
    else if (!allowed) headers['Access-Control-Allow-Origin'] = '*'; // dev only
    return new Response(null, { status: 204, headers });
  }
  await next();
  if (origin) {
    if (isAllowed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
    } else if (!allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', '*');
    }
  }
});

// Health check (public — no auth required)
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env?.ENVIRONMENT || 'unknown',
      version: '4.2.0',
      modules: ['pos', 'single-vendor', 'multi-vendor'],
      security: 'signed-JWT-auth-enabled',
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

export default app;
