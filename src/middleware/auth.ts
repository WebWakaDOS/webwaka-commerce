/**
 * WebWaka Commerce Suite — JWT Authentication Middleware
 * Reuses the Super Admin V2 auth pattern for consistency (Build Once Use Infinitely).
 * All /api/* routes require a valid Bearer token stored in SESSIONS_KV.
 *
 * Public routes (no auth required):
 *   GET /health
 *   GET /api/pos/products        — public product catalog browsing
 *   GET /api/single-vendor/products — public product catalog
 *   GET /api/multi-vendor/products  — public marketplace browsing
 */
import type { Context, Next } from 'hono';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
  tenantId: string;
}

export interface AuthEnv {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  TENANT_CONFIG?: KVNamespace;
  EVENTS?: KVNamespace;
}

/** Routes that do NOT require authentication */
const PUBLIC_ROUTES: { method: string; path: string }[] = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/api/pos/products' },
  { method: 'GET', path: '/api/single-vendor/products' },
  { method: 'GET', path: '/api/multi-vendor/products' },
  { method: 'GET', path: '/api/multi-vendor/vendors' },
];

function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(
    (r) => r.method === method && path.startsWith(r.path)
  );
}

/**
 * JWT Auth Middleware
 * Validates the Bearer token against SESSIONS_KV and attaches the user payload to context.
 * Replaces the insecure x-tenant-id header-only authentication.
 */
export async function jwtAuthMiddleware(
  c: Context<{ Bindings: AuthEnv }>,
  next: Next
): Promise<Response | void> {
  const method = c.req.method;
  const path = c.req.path;

  // Allow public routes through without auth
  if (isPublicRoute(method, path)) {
    return next();
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      { success: false, error: 'Unauthorized: missing or malformed Authorization header' },
      401
    );
  }

  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) {
    return c.json({ success: false, error: 'Unauthorized: empty token' }, 401);
  }

  // Validate token against SESSIONS_KV (same pattern as Super Admin V2 and Transport)
  let sessionData: string | null = null;
  try {
    sessionData = await c.env.SESSIONS_KV.get(`session:${token}`);
  } catch {
    return c.json({ success: false, error: 'Auth service unavailable' }, 503);
  }

  if (!sessionData) {
    return c.json(
      { success: false, error: 'Unauthorized: invalid or expired token' },
      401
    );
  }

  let user: AuthUser;
  try {
    user = JSON.parse(sessionData) as AuthUser;
  } catch {
    return c.json({ success: false, error: 'Unauthorized: malformed session data' }, 401);
  }

  // Attach user to context for downstream handlers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).set('user', user);

  // Also set tenantId from JWT payload (replaces x-tenant-id header)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).set('tenantId', user.tenantId);

  return next();
}

/**
 * Role guard helper — call inside route handlers after jwtAuthMiddleware.
 * Returns null if authorized, or a 403 Response if not.
 */
export function requireRole(
  c: Context,
  allowedRoles: string[]
): null | Response {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  if (!allowedRoles.includes(user.role)) {
    return c.json(
      {
        success: false,
        error: `Forbidden: requires one of [${allowedRoles.join(', ')}]`,
      },
      403
    );
  }
  return null;
}
