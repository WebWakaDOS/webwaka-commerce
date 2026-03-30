/**
 * NDPR Consent Gate Middleware Tests (P0-T05)
 *
 * Verifies:
 * 1. Returns 400 when ndpr_consent is missing from body
 * 2. Returns 400 when ndpr_consent is explicitly false
 * 3. Returns 400 when body is non-JSON (parse error)
 * 4. Passes through (calls next()) when ndpr_consent is true
 * 5. Error body shape: { success: false, error: 'NDPR consent required' }
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { ndprConsentMiddleware } from './ndpr';

function buildApp() {
  const app = new Hono();
  app.post('/checkout', ndprConsentMiddleware, async (c) => {
    const body = await c.req.json<{ ndpr_consent: boolean; value?: string }>();
    return c.json({ success: true, echo: body.value ?? 'ok' });
  });
  return app;
}

async function post(app: Hono, body: unknown) {
  const req = new Request('http://localhost/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return app.fetch(req);
}

describe('ndprConsentMiddleware', () => {
  const app = buildApp();

  it('returns 400 when ndpr_consent is missing', async () => {
    const res = await post(app, { items: [] });
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe('NDPR consent required');
  });

  it('returns 400 when ndpr_consent is explicitly false', async () => {
    const res = await post(app, { ndpr_consent: false });
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe('NDPR consent required');
  });

  it('returns 400 when ndpr_consent is null', async () => {
    const res = await post(app, { ndpr_consent: null });
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(false);
  });

  it('passes through and calls next when ndpr_consent is true', async () => {
    const res = await post(app, { ndpr_consent: true, value: 'passed' });
    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; echo: string };
    expect(data.success).toBe(true);
    expect(data.echo).toBe('passed');
  });

  it('route handler can still read the body after middleware consumed it', async () => {
    const res = await post(app, { ndpr_consent: true, value: 'body-reuse' });
    expect(res.status).toBe(200);
    const data = await res.json() as { echo: string };
    expect(data.echo).toBe('body-reuse');
  });

  it('returns 400 on malformed JSON (parse error gracefully handled)', async () => {
    const req = new Request('http://localhost/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid-json',
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
  });
});
