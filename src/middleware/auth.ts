/**
 * WebWaka Commerce Suite — JWT Authentication Middleware
 * Reuses the Super Admin V2 auth pattern for consistency (Build Once Use Infinitely).
 *
 * MV-1 addition: vendorAuthMiddleware — verifies vendor JWT (role='vendor')
 * and injects vendor_id + tenant_id into the Hono context.
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole, verifyJWT } from '@webwaka/core';
import { getJwtSecret } from '../utils/jwt-secret';
import type { Context, Next } from 'hono';

export const jwtAuthMiddleware = coreJwtAuthMiddleware({
  publicRoutes: [
    // ── Global ────────────────────────────────────────────────────────────────
    { method: 'GET',  path: '/health' },
    // ── POS (catalog read is public for barcode scanners) ─────────────────────
    { method: 'GET',  path: '/api/pos/products' },
    // ── Single-Vendor: public buyer-facing routes ─────────────────────────────
    { method: 'GET',  path: '/api/single-vendor/products' },
    { method: 'GET',  path: '/api/single-vendor/catalog' },
    { method: 'GET',  path: '/api/single-vendor/catalog/search' },
    { method: 'GET',  path: '/api/single-vendor/products/by-slug/:slug' },
    { method: 'GET',  path: '/api/single-vendor/products/:id' },
    { method: 'GET',  path: '/api/single-vendor/products/:id/variants' },
    { method: 'GET',  path: '/api/single-vendor/products/:id/reviews' },
    { method: 'POST', path: '/api/single-vendor/cart' },
    { method: 'GET',  path: '/api/single-vendor/cart/:token' },
    { method: 'POST', path: '/api/single-vendor/promo/validate' },
    { method: 'POST', path: '/api/single-vendor/checkout' },
    { method: 'GET',  path: '/api/single-vendor/orders/:id/track' }, // T-CVC-02: redirects to Logistics portal
    { method: 'GET',  path: '/api/single-vendor/shipping/estimate' },
    // NOTE: /api/single-vendor/delivery-zones removed (T-CVC-01) — returns 410 Gone
    { method: 'POST', path: '/api/single-vendor/auth/login' },
    { method: 'POST', path: '/api/single-vendor/auth/request-otp' },
    { method: 'POST', path: '/api/single-vendor/auth/verify-otp' },
    { method: 'GET',  path: '/api/single-vendor/orders/:id/delivery-options' },
    // Paystack webhook — signed with HMAC-SHA512, not a JWT-protected route
    { method: 'POST', path: '/api/single-vendor/paystack/webhook' },
    // ── Multi-Vendor: public buyer-facing routes ───────────────────────────────
    { method: 'GET',  path: '/api/multi-vendor/vendors' },
    { method: 'GET',  path: '/api/multi-vendor/vendors/:id' },
    { method: 'GET',  path: '/api/multi-vendor/vendors/:id/products' },
    { method: 'GET',  path: '/api/multi-vendor/catalog' },
    { method: 'GET',  path: '/api/multi-vendor/catalog/search' },
    { method: 'POST', path: '/api/multi-vendor/cart' },
    { method: 'GET',  path: '/api/multi-vendor/cart/:token' },
    { method: 'POST', path: '/api/multi-vendor/checkout' },
    { method: 'GET',  path: '/api/multi-vendor/orders/track' }, // T-CVC-02: redirects to Logistics portal
    { method: 'GET',  path: '/api/multi-vendor/shipping/estimate' },
    // Vendor OTP auth — two canonical paths (MV-1 + MV-2 alias)
    { method: 'POST', path: '/api/multi-vendor/auth/vendor-request-otp' },
    { method: 'POST', path: '/api/multi-vendor/auth/vendor-verify-otp' },
    { method: 'POST', path: '/api/multi-vendor/vendor-auth/request-otp' },
    { method: 'POST', path: '/api/multi-vendor/vendor-auth/verify-otp' },
    // Paystack webhook — signed with HMAC-SHA512, not a JWT-protected route
    { method: 'POST', path: '/api/multi-vendor/paystack/webhook' },
    // Sync API — offline-first sync endpoint; tenant validated server-side via x-tenant-id
    { method: 'POST', path: '/api/sync/sync' },
  ],
});

export const requireRole = coreRequireRole;

/**
 * Vendor JWT middleware for Hono routes.
 * Validates Bearer token with role='vendor' and injects:
 *   c.set('vendorId', ...)       — the authenticated vendor's ID
 *   c.set('vendorTenantId', ...) — the marketplace tenant ID from the JWT
 *
 * Invariant: tenantId is ALWAYS extracted from the validated JWT payload —
 * NEVER from request headers or body (cross-tenant injection prevention).
 *
 * Usage (inline on a vendor-guarded route):
 *   app.get('/vendor/orders', vendorAuthMiddleware, async (c) => {
 *     const vendorId = c.get('vendorId');
 *   });
 */
export async function vendorAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return c.json({ success: false, error: 'Vendor authentication required' }, 401);
  }

  const jwtSecret: string = getJwtSecret(c.env as { JWT_SECRET?: string });
  // FIX: use verifyJWT (uppercase T) — canonical export from @webwaka/core
  const claims = await verifyJWT(token, jwtSecret);

  if (!claims || claims.role !== 'vendor') {
    return c.json({ success: false, error: 'Invalid or expired vendor token' }, 401);
  }

  // FIX: tenantId sourced exclusively from JWT claims — never from headers
  // This prevents cross-tenant data injection attacks (Invariant: Build Once Use Infinitely)
  c.set('vendorId', String(claims.sub));
  c.set('vendorTenantId', String(claims.tenantId));
  await next();
}
