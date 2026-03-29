/**
 * WebWaka Commerce Suite — JWT Authentication Middleware
 * Security hardened 2026-03-29:
 *   - Validates HS256-signed JWTs via JWT_SECRET (replaces KV session lookup)
 *   - tenantId read exclusively from JWT payload (never from x-tenant-id header)
 *   - requireRole() and requirePermission() enforced on write operations
 *
 * Public routes (no auth required):
 *   GET /health
 *   GET /api/pos/products        — public product catalog browsing
 *   GET /api/single-vendor/products — public product catalog
 *   GET /api/multi-vendor/products  — public marketplace browsing
 *   GET /api/multi-vendor/vendors   — public vendor listing
 */
import type { Context, Next } from 'hono';

export interface AuthUser {
  userId: string;
  email: string;
  role: string;
  tenantId: string;
  permissions: string[];
}

export interface AuthEnv {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  RATE_LIMIT_KV?: KVNamespace;
  TENANT_CONFIG?: KVNamespace;
  EVENTS?: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT?: string;
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
 * Verify an HS256-signed JWT using the Workers-native Web Crypto API.
 * Returns the decoded payload or null if invalid/expired.
 */
async function verifyJWT(token: string, secret: string): Promise<any | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      (ch) => ch.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sigBytes,
      enc.encode(`${headerB64}.${payloadB64}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(
      atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))
    );
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * JWT Auth Middleware
 * Validates the HS256-signed Bearer JWT using JWT_SECRET.
 * Attaches decoded user payload to context under 'user' and 'tenantId' keys.
 * tenantId is ALWAYS sourced from the JWT payload — never from request headers.
 */
export async function jwtAuthMiddleware(
  c: Context<{ Bindings: AuthEnv }>,
  next: Next
): Promise<Response | void> {
  const method = c.req.method;
  const path = c.req.path;

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

  const token = authHeader.slice(7).trim();
  if (!token) {
    return c.json({ success: false, error: 'Unauthorized: empty token' }, 401);
  }

  const secret = c.env.JWT_SECRET;
  if (!secret) {
    console.error('FATAL: JWT_SECRET is not configured');
    return c.json({ success: false, error: 'Auth service misconfigured' }, 503);
  }

  const payload = await verifyJWT(token, secret);
  if (!payload) {
    return c.json(
      { success: false, error: 'Unauthorized: invalid or expired token' },
      401
    );
  }

  const user: AuthUser = {
    userId: payload.sub || payload.userId,
    email: payload.email,
    role: payload.role,
    tenantId: payload.tenantId, // ALWAYS from JWT payload — never from headers
    permissions: payload.permissions || [],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).set('user', user);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (c as any).set('tenantId', user.tenantId);

  return next();
}

/**
 * Role guard — call inside route handlers after jwtAuthMiddleware.
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

/**
 * Permission guard — checks fine-grained permissions from JWT payload.
 */
export function requirePermission(
  c: Context,
  permission: string
): null | Response {
  const user = c.get('user') as AuthUser | undefined;
  if (!user) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }
  const hasPermission =
    user.permissions?.includes(permission) ||
    user.permissions?.includes('read:all') ||
    user.role === 'SUPER_ADMIN';
  if (!hasPermission) {
    return c.json(
      { success: false, error: `Forbidden: requires permission '${permission}'` },
      403
    );
  }
  return null;
}
