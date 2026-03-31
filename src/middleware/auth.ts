/**
 * WebWaka Commerce Suite — JWT Authentication Middleware
 * Reuses the Super Admin V2 auth pattern for consistency (Build Once Use Infinitely).
 *
 * MV-1 addition: vendorAuthMiddleware — verifies vendor JWT (role='vendor')
 * and injects vendor_id + tenant_id into the Hono context.
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole, verifyJwt } from '@webwaka/core';
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
    { method: 'GET',  path: '/api/single-vendor/orders/:id/track' },
    { method: 'GET',  path: '/api/single-vendor/shipping/estimate' },
    { method: 'GET',  path: '/api/single-vendor/delivery-zones' },
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
    { method: 'GET',  path: '/api/multi-vendor/orders/track' },
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
 *   c.set('vendorId', ...)    — the authenticated vendor's ID
 *   c.set('vendorTenantId', ...) — the marketplace tenant ID from the JWT
 *
 * Usage (inline on a vendor-guarded route):
 *   app.get('/vendor/orders', vendorAuthMiddleware, async (c) => {
 *     const vendorId = c.get('vendorId');
 *   });
 */
export async function vendorAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token) {
    return c.json({ success: false, error: 'Vendor authentication required' }, 401);
  }

  const jwtSecret: string = getJwtSecret(c.env as { JWT_SECRET?: string });
  const claims = await verifyJwt(token, jwtSecret);

  if (!claims || claims.role !== 'vendor') {
    return c.json({ success: false, error: 'Invalid or expired vendor token' }, 401);
  }

  if (claims.tenant !== tenantId) {
    return c.json({ success: false, error: 'Vendor token tenant mismatch' }, 403);
  }

  c.set('vendorId', String(claims.vendor_id));
  c.set('vendorTenantId', String(claims.tenant));
  await next();
}
