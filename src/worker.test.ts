/**
 * Worker CORS tests (P0-T08)
 *
 * Tests the ALLOWED_ORIGINS filtering logic in isolation using a minimal
 * Hono app that mirrors the CORS configuration in worker.ts.
 *
 * The origin callback from worker.ts:
 *   const allowed = (c.env?.ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim());
 *   if (allowed.includes('*')) return origin;
 *   return allowed.includes(origin) ? origin : '';
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

/** Mirror of worker.ts CORS origin resolver — extracted for testability. */
function buildCorsApp(allowedOriginsEnv: string | undefined) {
  const app = new Hono<{ Bindings: { ALLOWED_ORIGINS?: string } }>();
  app.use(
    '*',
    cors({
      origin: (origin) => {
        const allowed = (allowedOriginsEnv ?? '*').split(',').map((s) => s.trim());
        if (allowed.includes('*')) return origin;
        return allowed.includes(origin) ? origin : '';
      },
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
      credentials: true,
    }),
  );
  app.get('/health', (c) => c.json({ ok: true }));
  return app;
}

async function preflight(app: ReturnType<typeof buildCorsApp>, origin: string) {
  return app.fetch(
    new Request('http://localhost/health', {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
      },
    }),
  );
}

describe('CORS origin allowlist (P0-T08)', () => {
  describe('dev mode — ALLOWED_ORIGINS not set (defaults to *)', () => {
    const app = buildCorsApp(undefined);

    it('allows any origin when ALLOWED_ORIGINS is undefined', async () => {
      const res = await preflight(app, 'https://any-origin.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://any-origin.example.com');
    });

    it('allows localhost origins in dev mode', async () => {
      const res = await preflight(app, 'http://localhost:3000');
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    });
  });

  describe('dev mode — ALLOWED_ORIGINS = "*"', () => {
    const app = buildCorsApp('*');

    it('allows any origin when ALLOWED_ORIGINS is literal *', async () => {
      const res = await preflight(app, 'https://random.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://random.com');
    });
  });

  describe('production mode — explicit allowlist', () => {
    const app = buildCorsApp(
      'https://app.webwaka.com, https://pos.webwaka.com, https://tnt_demo.webwaka.shop',
    );

    it('allows a listed origin', async () => {
      const res = await preflight(app, 'https://app.webwaka.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://app.webwaka.com');
    });

    it('allows a second listed origin', async () => {
      const res = await preflight(app, 'https://pos.webwaka.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://pos.webwaka.com');
    });

    it('allows a tenant subdomain in the list', async () => {
      const res = await preflight(app, 'https://tnt_demo.webwaka.shop');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://tnt_demo.webwaka.shop');
    });

    it('returns empty origin for an unlisted origin', async () => {
      const res = await preflight(app, 'https://evil-attacker.com');
      const acao = res.headers.get('access-control-allow-origin');
      expect(acao === null || acao === '').toBe(true);
    });

    it('does NOT allow a partial-match (no subdomain wildcard)', async () => {
      const res = await preflight(app, 'https://not-app.webwaka.com');
      const acao = res.headers.get('access-control-allow-origin');
      expect(acao === null || acao === '').toBe(true);
    });
  });

  describe('edge cases', () => {
    it('trims whitespace from ALLOWED_ORIGINS entries', async () => {
      const app = buildCorsApp('  https://trimmed.example.com  ,  https://other.com  ');
      const res = await preflight(app, 'https://trimmed.example.com');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://trimmed.example.com');
    });
  });
});
