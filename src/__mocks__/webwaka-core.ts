/**
 * Vitest mock for @webwaka/core
 *
 * Vitest maps @webwaka/core → this file via vitest.config.ts resolve.alias.
 */
import type { Context, MiddlewareHandler } from 'hono';

// ── Tenant helpers ────────────────────────────────────────────────────────────

export const getTenantId = (c: Context): string | null => {
  return (
    c.req.raw.headers.get('x-tenant-id') ??
    c.req.raw.headers.get('X-Tenant-ID') ??
    null
  );
};

// ── Auth middleware stubs — pass-through ──────────────────────────────────────

export const requireRole = (_roles: string[]): MiddlewareHandler => {
  return async (_c, next) => { await next(); };
};

export const jwtAuthMiddleware = (_opts?: unknown): MiddlewareHandler => {
  return async (_c, next) => { await next(); };
};

// ── JWT utilities ─────────────────────────────────────────────────────────────

const b64url = (str: string) =>
  btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

const b64urlDecode = (s: string) => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    s.length + (4 - (s.length % 4)) % 4, '=',
  );
  return atob(padded);
};

/** Mock signJwt — produces a proper header.payload.fakesig JWT. */
export async function signJwt(
  payload: Record<string, unknown>,
  _secret: string,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

/** Mock verifyJwt — decodes ANY syntactically valid JWT without signature check. */
export async function verifyJwt(
  token: string,
  _secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(b64urlDecode(parts[1]!)) as Record<string, unknown>;
    if (claims['exp'] && (claims['exp'] as number) < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

// ── Termii SMS stub ───────────────────────────────────────────────────────────

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

/** Mock sendTermiiSms — returns success immediately without making HTTP calls. */
export async function sendTermiiSms(
  _opts: TermiiSendSmsOptions,
): Promise<TermiiSendSmsResult> {
  return { success: true, messageId: 'mock-msg-id' };
}
