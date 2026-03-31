/**
 * @webwaka/core — Build Once Use Infinitely
 *
 * Shared platform primitives for the WebWaka multi-repo ecosystem.
 * Designed for Cloudflare Workers (Web Crypto API, no Node.js built-ins).
 *
 * Exports:
 *  - getTenantId       — Multi-tenant header resolution
 *  - requireRole       — RBAC middleware factory
 *  - jwtAuthMiddleware — JWT gate with public route allowlist
 *  - signJwt           — HMAC-SHA256 JWT signer (HS256)
 *  - verifyJwt         — HMAC-SHA256 JWT verifier (HS256)
 *  - sendTermiiSms     — Termii SMS API client (Nigeria-first)
 *
 * Architecture invariants:
 *  [MTT] Every token/claim carries tenant_id for multi-tenancy enforcement.
 *  [CFD] Uses only Web Crypto API — no Node crypto module required.
 *  [SEC] Signature is always verified before claims are trusted.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';

// ─── Base64URL helpers ────────────────────────────────────────────────────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - (s.length % 4)) % 4,
    '=',
  );
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

// ─── JWT — HS256 sign / verify ────────────────────────────────────────────────

/**
 * Sign a JWT using HMAC-SHA256 (HS256).
 * Compatible with Cloudflare Workers Web Crypto API.
 *
 * @param payload  - JWT claims object (must include exp for expiry enforcement)
 * @param secret   - Shared HMAC secret (minimum 32 chars recommended)
 * @returns        Signed JWT string in format: header.payload.signature
 */
export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  const signature = b64urlEncode(new Uint8Array(sig));

  return `${signingInput}.${signature}`;
}

/**
 * Verify a JWT signed with HMAC-SHA256 (HS256).
 *
 * Returns null if:
 * - Token is malformed
 * - Signature is invalid
 * - Token has expired (exp claim)
 *
 * @param token   - JWT string
 * @param secret  - Shared HMAC secret
 * @returns       Decoded claims object, or null if invalid
 */
export async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSig] = parts as [string, string, string];
  const enc = new TextEncoder();
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );

    const sigBytes = b64urlDecode(encodedSig);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes as unknown as ArrayBuffer, enc.encode(signingInput));
    if (!valid) return null;

    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(encodedPayload)),
    ) as Record<string, unknown>;

    if (typeof claims['exp'] === 'number' && claims['exp'] < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return claims;
  } catch {
    return null;
  }
}

// ─── Tenant ID Resolution ─────────────────────────────────────────────────────

/**
 * Extract tenant ID from Hono request context.
 * Reads x-tenant-id (lowercase canonical) or X-Tenant-ID (legacy uppercase).
 *
 * [MTT] All routes that access D1 must call getTenantId and null-guard.
 */
export function getTenantId(c: Context): string | null {
  return (
    c.req.raw.headers.get('x-tenant-id') ??
    c.req.raw.headers.get('X-Tenant-ID') ??
    null
  );
}

// ─── RBAC — requireRole ───────────────────────────────────────────────────────

/**
 * RBAC middleware factory.
 * Expects jwtAuthMiddleware to have run first and injected 'userRole' into context.
 *
 * Usage:
 *   app.get('/admin/reports', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), handler)
 *
 * Returns 403 if role is absent or not in the allowed set.
 */
export function requireRole(roles: string[]): MiddlewareHandler {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const userRole = c.get('userRole') as string | undefined;
    if (!userRole || !roles.includes(userRole)) {
      return c.json(
        { success: false, error: 'Insufficient permissions' },
        403,
      );
    }
    await next();
  };
}

// ─── JWT Auth Middleware ──────────────────────────────────────────────────────

export interface PublicRoute {
  method: string;
  path: string;
}

export interface JwtAuthOptions {
  publicRoutes?: PublicRoute[];
}

/**
 * Match a URL path against a route pattern that may include :param segments.
 * Query strings are stripped before matching.
 *
 * Examples:
 *   matchPath('/api/products/:id', '/api/products/123')   → true
 *   matchPath('/api/products/:id', '/api/products/123/x') → false
 *   matchPath('/api/products', '/api/products')            → true
 */
function matchPath(pattern: string, requestPath: string): boolean {
  const cleanPath = requestPath.split('?')[0] ?? '';
  const patternParts = pattern.split('/');
  const pathParts = cleanPath.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((seg, i) => seg.startsWith(':') || seg === pathParts[i]);
}

/**
 * JWT authentication middleware with public route allowlist.
 * On non-public routes: validates Authorization: Bearer <JWT> with HS256.
 * Injects into Hono context:
 *   c.set('userId',    string)   — JWT sub claim
 *   c.set('userRole',  string)   — JWT role claim (used by requireRole)
 *   c.set('tenantId',  string)   — JWT tenant claim
 *   c.set('jwtClaims', object)   — Full decoded claims
 *
 * Usage:
 *   app.use('/api/*', jwtAuthMiddleware({ publicRoutes: [...] }))
 */
export function jwtAuthMiddleware(opts: JwtAuthOptions = {}): MiddlewareHandler {
  const publicRoutes = opts.publicRoutes ?? [];

  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method;
    const path = c.req.path;

    const isPublic = publicRoutes.some(
      (r) => r.method === method && matchPath(r.path, path),
    );

    if (isPublic) {
      await next();
      return;
    }

    const auth = c.req.header('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

    if (!token) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }

    const env = c.env as Record<string, unknown> | undefined;
    const jwtSecret = typeof env?.['JWT_SECRET'] === 'string' ? env['JWT_SECRET'] : null;

    if (!jwtSecret) {
      console.error('[jwtAuthMiddleware] JWT_SECRET binding not configured');
      return c.json({ success: false, error: 'Server configuration error' }, 500);
    }

    const claims = await verifyJwt(token, jwtSecret);

    if (!claims) {
      return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }

    c.set('jwtClaims', claims);
    c.set('userId', typeof claims['sub'] === 'string' ? claims['sub'] : '');
    c.set('userRole', typeof claims['role'] === 'string' ? claims['role'] : '');
    c.set('tenantId', typeof claims['tenant'] === 'string' ? claims['tenant'] : '');

    await next();
  };
}

// ─── Termii SMS ───────────────────────────────────────────────────────────────

export interface TermiiSendSmsOptions {
  to: string;
  message: string;
  apiKey: string;
  channel?: 'generic' | 'dnd' | 'whatsapp';
  from?: string;
}

export interface TermiiSendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an SMS via Termii API (Nigeria-first, Africa-ready).
 * Production endpoint: https://api.ng.termii.com/api/sms/send
 * Docs: https://developers.termii.com/
 *
 * [NGN-1] Termii is the primary SMS provider for Nigeria. For other
 *         African markets, add a provider abstraction on top of this util.
 */
export async function sendTermiiSms(opts: TermiiSendSmsOptions): Promise<TermiiSendSmsResult> {
  const { to, message, apiKey, channel = 'generic', from = 'WebWaka' } = opts;

  try {
    const res = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to,
        from,
        sms: message,
        type: 'plain',
        channel,
        api_key: apiKey,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => 'unknown');
      console.error(`[sendTermiiSms] HTTP ${res.status}: ${errText}`);
      return { success: false, error: `HTTP ${res.status}` };
    }

    const data = (await res.json()) as {
      code?: string;
      message_id?: string;
      message?: string;
    };

    const success = data.code === 'ok' || data.message === 'Successfully Sent';
    return {
      success,
      ...(data.message_id != null ? { messageId: data.message_id } : {}),
      ...(!success ? { error: data.message ?? 'Unknown error' } : {}),
    };
  } catch (err) {
    console.error('[sendTermiiSms] Network error:', err);
    return { success: false, error: 'Network error' };
  }
}
