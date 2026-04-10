/**
 * NDPR Consent Gate Middleware (P0-T05)
 *
 * The Nigeria Data Protection Regulation (NDPR) requires that data subjects
 * explicitly consent before their personal data is processed.  This middleware
 * enforces that gate on every route that collects customer data at checkout or
 * cart creation.
 *
 * Hono caches the parsed request body on `HonoRequest` after the first
 * `c.req.json()` call, so consuming the body here does NOT prevent the
 * downstream route handler from also calling `c.req.json()`.
 */

import type { MiddlewareHandler } from 'hono';

export const ndprConsentMiddleware: MiddlewareHandler = async (c, next) => {
  const body = await c.req.json<{ ndpr_consent?: unknown }>().catch(() => ({ ndpr_consent: undefined }));
  if (!body.ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent required' }, 400);
  }
  await next();
};
