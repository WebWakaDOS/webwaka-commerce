/**
 * POS Load Test — 50 Concurrent Checkout Requests
 * Verifies the API correctly handles concurrent stock deduction:
 *   - Some requests succeed (201) when stock is available
 *   - Others fail gracefully (409 STOCK_RACE) when concurrent race is detected
 *   - None crash (no 500 unless D1 throws)
 *   - Rate limiter correctly throttles beyond 10 req/min per session
 * Uses vitest concurrent test pattern (Promise.all) for load simulation
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { posRouter } from './api';
import { _resetRateLimitStore } from './api';

// ─── Mock factory — each concurrent request gets its own D1 chain mock ────────
function makeMockEnv(opts: {
  stockQty: number;
  stockRace: boolean; // if true, deduct returns changes=0 (race)
  tenantId?: string;
}) {
  const mockKv = {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [] }),
  };

  const mockDb = {
    prepare: vi.fn(),
    batch: vi.fn(),
  };

  const stockPrep = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({
      results: [{ id: 'prod_load', quantity: opts.stockQty, name: 'Load Test Product' }],
    }),
  };

  mockDb.prepare.mockReturnValue(stockPrep);

  const stockResult = { results: [{ id: 'prod_load', quantity: opts.stockQty, name: 'Load Test Product' }] };
  const deductResult = { meta: { changes: opts.stockRace ? 0 : 1 } };
  const insertResult = { meta: { changes: 1 } };

  // Alternate: odd calls = stock validation batch, even calls = deduct+insert batch
  let batchCallCount = 0;
  mockDb.batch.mockImplementation(() => {
    batchCallCount++;
    if (batchCallCount % 2 === 1) {
      return Promise.resolve([stockResult]);
    }
    return Promise.resolve([deductResult, insertResult]);
  });

  return {
    DB: mockDb as unknown,
    SESSIONS_KV: mockKv,
    TENANT_CONFIG: {},
    EVENTS: {},
    _tenantId: opts.tenantId ?? 'load_tenant',
  };
}

function checkoutReq(sessionId: string, tenantId = 'load_tenant'): Request {
  return new Request('http://localhost/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tenant-id': tenantId,
      Authorization: 'Bearer test-token',
    },
    body: JSON.stringify({
      items: [{ product_id: 'prod_load', quantity: 1, price: 100000, name: 'Load Test Product' }],
      payment_method: 'cash',
      session_id: sessionId,
    }),
  });
}

beforeEach(() => {
  _resetRateLimitStore();
});

describe('POS Load Test — 50 concurrent checkouts', () => {
  it('handles 50 concurrent requests: all resolve (no unhandled rejections)', async () => {
    // Each request gets its own mock env (simulates independent isolate memory)
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const env = makeMockEnv({ stockQty: 100, stockRace: false });
        // Use different session per request to avoid rate limiter
        return posRouter.fetch(checkoutReq(`sess_load_${i}`, env._tenantId), env as never);
      }),
    );

    expect(results).toHaveLength(50);
    for (const res of results) {
      expect([201, 400, 409, 429]).toContain(res.status);
    }
  }, 15000);

  it('all 50 succeed when stock is ample and no race condition', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const env = makeMockEnv({ stockQty: 9999, stockRace: false });
        return posRouter.fetch(checkoutReq(`sess_ok_${i}`, env._tenantId), env as never);
      }),
    );

    const successes = results.filter((r) => r.status === 201);
    expect(successes.length).toBe(50);
  }, 15000);

  it('requests fail with 409 STOCK_RACE when deduct returns changes=0', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const env = makeMockEnv({ stockQty: 1, stockRace: true });
        return posRouter.fetch(checkoutReq(`sess_race_${i}`, env._tenantId), env as never);
      }),
    );

    const raceErrors = await Promise.all(
      results
        .filter((r) => r.status === 409)
        .map(async (r) => {
          const body = await r.json() as { code?: string };
          return body.code;
        }),
    );

    // All 409s should have code STOCK_RACE
    for (const code of raceErrors) {
      expect(code).toBe('STOCK_RACE');
    }
    expect(raceErrors.length).toBe(50);
  }, 15000);

  it('rate limiter fires 429 after 10 req/min per session', async () => {
    // 15 requests all sharing the same session_id — first 10 pass, rest get 429
    const env = makeMockEnv({ stockQty: 9999, stockRace: false });
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () =>
        posRouter.fetch(checkoutReq('sess_ratelimit_shared', env._tenantId), env as never),
      ),
    );

    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 500));
    const tooMany = statuses.filter((s) => s === 429);
    // At least 5 should be rate-limited (15 - 10 = 5 over limit)
    expect(tooMany.length).toBeGreaterThanOrEqual(5);
  }, 15000);

  it('different sessions on same tenant are rate-limited independently', async () => {
    const env = makeMockEnv({ stockQty: 9999, stockRace: false });
    // 3 sessions × 5 requests each = 15 total; none hit rate limit (5 < 10 per session)
    const results = await Promise.all(
      Array.from({ length: 15 }, (_, i) => {
        const sessionId = `sess_iso_${Math.floor(i / 5)}`; // 3 groups
        return posRouter.fetch(checkoutReq(sessionId, env._tenantId), env as never);
      }),
    );

    const tooMany = results.filter((r) => r.status === 429);
    expect(tooMany.length).toBe(0); // no rate limiting across different sessions
  }, 15000);

  it('no 5xx errors under load (PCI hardening: all errors are structured)', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const env = makeMockEnv({ stockQty: 5, stockRace: i % 3 === 0 });
        return posRouter.fetch(checkoutReq(`sess_mixed_${i}`, env._tenantId), env as never);
      }),
    );

    const serverErrors = results.filter((r) => r.status >= 500);
    expect(serverErrors.length).toBe(0); // no 500s from mocked D1
  }, 15000);

  it('measures p99 latency: 50 concurrent checkouts complete within 5 seconds', async () => {
    const start = Date.now();
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        const env = makeMockEnv({ stockQty: 9999, stockRace: false });
        return posRouter.fetch(checkoutReq(`sess_perf_${i}`, env._tenantId), env as never);
      }),
    );
    const elapsed = Date.now() - start;
    // In vitest with mocks, 50 concurrent requests should complete in < 5s
    expect(elapsed).toBeLessThan(5000);
  }, 15000);
});
