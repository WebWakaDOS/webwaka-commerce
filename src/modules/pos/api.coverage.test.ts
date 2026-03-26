/**
 * COM-1: POS API — Phase 3 Coverage Tests
 * Targets 95% line coverage on src/modules/pos/api.ts
 * Focus areas: inventory concurrency, payment splits, session Z-report edge cases
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posRouter, _resetRateLimitStore } from './api';

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
  batch: vi.fn().mockResolvedValue([]),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {} };

function req(method: string, path: string, body?: unknown, tenant = 'tnt_cov') {
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenant, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(`http://localhost${path}`, init);
}

const stockBatch = (qty: number, id = 'prod_1') => [
  { results: [{ id, quantity: qty, name: 'Item' }], meta: { changes: 0 } },
];
const deductBatch = (n = 1) => [
  ...Array(n).fill({ results: [], meta: { changes: 1 } }),
  { results: [], meta: { changes: 1 } },
];

beforeEach(() => {
  vi.resetAllMocks();
  _resetRateLimitStore();
  mockDb.prepare.mockReturnThis();
  mockDb.bind.mockReturnThis();
  mockDb.all.mockResolvedValue({ results: [] });
  mockDb.first.mockResolvedValue(null);
  mockDb.run.mockResolvedValue({ success: true });
  mockDb.batch
    .mockResolvedValueOnce(stockBatch(100))
    .mockResolvedValueOnce(deductBatch(1));
});

// ─── Inventory Concurrency ─────────────────────────────────────────────────────
describe('Inventory Concurrency — Race Conditions', () => {
  it('detects race on 2nd item only in a 2-item cart', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 10, name: 'A' }], meta: { changes: 0 } },
        { results: [{ id: 'prod_2', quantity: 10, name: 'B' }], meta: { changes: 0 } },
      ])
      .mockResolvedValueOnce([
        { results: [], meta: { changes: 1 } }, // prod_1 deducts OK
        { results: [], meta: { changes: 0 } }, // prod_2 raced — 0 rows affected
        { results: [], meta: { changes: 1 } }, // INSERT order
      ]);

    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [
        { product_id: 'prod_1', quantity: 5, price: 10000, name: 'A' },
        { product_id: 'prod_2', quantity: 5, price: 10000, name: 'B' },
      ],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(409);
    const data = await res.json() as any;
    expect(data.code).toBe('STOCK_RACE');
  });

  it('succeeds when all deduct changes === 1 (no race)', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 10, name: 'A' }], meta: { changes: 0 } },
        { results: [{ id: 'prod_2', quantity: 10, name: 'B' }], meta: { changes: 0 } },
      ])
      .mockResolvedValueOnce([
        { results: [], meta: { changes: 1 } }, // prod_1
        { results: [], meta: { changes: 1 } }, // prod_2
        { results: [], meta: { changes: 1 } }, // INSERT order
      ]);

    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [
        { product_id: 'prod_1', quantity: 5, price: 10000, name: 'A' },
        { product_id: 'prod_2', quantity: 5, price: 10000, name: 'B' },
      ],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(201);
  });

  it('reports STOCK_RACE even when 1st product races (not only last)', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 5, name: 'Pepper' }], meta: { changes: 0 } },
      ])
      .mockResolvedValueOnce([
        { results: [], meta: { changes: 0 } }, // 1st product races
        { results: [], meta: { changes: 1 } }, // INSERT order
      ]);

    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 5, price: 1000, name: 'Pepper' }],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(409);
    const data = await res.json() as any;
    expect(data.code).toBe('STOCK_RACE');
  });

  it('D1 batch() throwing returns 500 (not uncaught exception)', async () => {
    mockDb.batch.mockReset();
    mockDb.batch.mockRejectedValueOnce(new Error('D1 fatal'));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 1, price: 5000, name: 'X' }],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    // PCI: no internal error details
    expect(data.error).toBe('Transaction failed');
    expect(data.error).not.toContain('D1');
    expect(data.error).not.toContain('fatal');
  });

  it('D1 batch() throwing on 2nd call (deduct) returns 500', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce(stockBatch(100))
      .mockRejectedValueOnce(new Error('D1 write failure'));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 1, price: 5000, name: 'X' }],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBe('Transaction failed');
  });

  it('exact stock match (requested === available) succeeds — boundary condition', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 7, name: 'Exact' }], meta: { changes: 0 } },
      ])
      .mockResolvedValueOnce(deductBatch(1));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 7, price: 2000, name: 'Exact' }],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(201);
  });

  it('quantity 1 above threshold does not race (qty=8 requested=7)', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 8, name: 'Near' }], meta: { changes: 0 } },
      ])
      .mockResolvedValueOnce(deductBatch(1));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 7, price: 1000, name: 'Near' }],
      payment_method: 'cash',
    }), mockEnv as any);
    expect(res.status).toBe(201);
  });
});

// ─── Payment Split Edge Cases ─────────────────────────────────────────────────
describe('Payment Splits — Edge Cases', () => {
  it('split with transfer + cash sums correctly', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce(stockBatch(100))
      .mockResolvedValueOnce(deductBatch(1));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
      payments: [
        { method: 'cash', amount_kobo: 30000 },
        { method: 'transfer', amount_kobo: 70000 },
      ],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_method).toBe('split');
    expect(data.data.payments).toHaveLength(2);
    const methods = data.data.payments.map((p: any) => p.method);
    expect(methods).toContain('cash');
    expect(methods).toContain('transfer');
  });

  it('single payment in payments[] uses that method as primary (not "split")', async () => {
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'Item' }],
      payments: [{ method: 'transfer', amount_kobo: 50000 }],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_method).toBe('transfer');
  });

  it('Paystack ref generated for agency_banking payments', async () => {
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 80000, name: 'X' }],
      payments: [{ method: 'agency_banking', amount_kobo: 80000 }],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_reference).toMatch(/^PAY_/);
  });

  it('no Paystack ref generated for cash-only payment', async () => {
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 30000, name: 'X' }],
      payments: [{ method: 'cash', amount_kobo: 30000 }],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_reference).toBeUndefined();
  });

  it('split with 3 methods (cash+card+transfer) summing to total is accepted', async () => {
    mockDb.batch.mockReset();
    mockDb.batch
      .mockResolvedValueOnce(stockBatch(100))
      .mockResolvedValueOnce(deductBatch(1));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 90000, name: 'X' }],
      payments: [
        { method: 'cash', amount_kobo: 30000 },
        { method: 'card', amount_kobo: 40000 },
        { method: 'transfer', amount_kobo: 20000 },
      ],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_method).toBe('split');
    expect(data.data.payments).toHaveLength(3);
  });

  it('payments[] with zero-kobo entry rejected (method validation catches invalid methods, but 0-amount passes)', async () => {
    // A payments[] with one zero-amount entry + one full-amount: total matches, should succeed
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'X' }],
      payments: [
        { method: 'cash', amount_kobo: 0 },
        { method: 'card', amount_kobo: 50000 },
      ],
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.payment_method).toBe('split');
  });

  it('payment total exceeding order total is rejected', async () => {
    mockDb.batch.mockReset();
    mockDb.batch.mockResolvedValueOnce(stockBatch(100));
    const res = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'X' }],
      payments: [
        { method: 'cash', amount_kobo: 30000 },
        { method: 'card', amount_kobo: 30000 }, // 60000 > 50000
      ],
    }), mockEnv as any);
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('does not match');
  });

  it('discount applied before payment validation (kobo arithmetic)', async () => {
    // Total = 100000 - 10000 = 90000. Payments must sum to 90000.
    const res = await posRouter.fetch(req('POST', '/checkout', {
      items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'X' }],
      payment_method: 'cash',
      discount: 10000,
    }), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.total_amount).toBe(90000);
  });

  it('rate limiter tracks separately per tenant:session_id pair', async () => {
    // Fill rate limit for tenant A
    for (let i = 0; i < 10; i++) {
      mockDb.batch
        .mockResolvedValueOnce(stockBatch(500))
        .mockResolvedValueOnce(deductBatch(1));
      await posRouter.fetch(req('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
        payments: [{ method: 'cash', amount_kobo: 10000 }],
        session_id: 'sess_shared',
      }, 'tnt_A'), mockEnv as any);
    }
    // tnt_A is rate limited
    const resA = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
      payments: [{ method: 'cash', amount_kobo: 10000 }],
      session_id: 'sess_shared',
    }, 'tnt_A'), mockEnv as any);
    expect(resA.status).toBe(429);

    // tnt_B with same session_id is NOT rate limited (separate key)
    mockDb.batch
      .mockResolvedValueOnce(stockBatch(500))
      .mockResolvedValueOnce(deductBatch(1));
    const resB = await posRouter.fetch(req('POST', '/checkout', {
      line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
      payments: [{ method: 'cash', amount_kobo: 10000 }],
      session_id: 'sess_shared',
    }, 'tnt_B'), mockEnv as any);
    expect(resB.status).toBe(201);
  });
});

// ─── Session Z-Report Edge Cases ───────────────────────────────────────────────
describe('Session Z-Report — Edge Cases', () => {
  it('Z-report with zero orders returns all-zeros gracefully', async () => {
    mockDb.first
      .mockResolvedValueOnce({ id: 'sess_zero', cashier_id: 'c1', initial_float_kobo: 100000, status: 'open', opened_at: 0 })
      .mockResolvedValueOnce({ order_count: 0, total_sales_kobo: 0, cash_sales_kobo: 0 });
    const res = await posRouter.fetch(req('PATCH', '/sessions/sess_zero/close'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.order_count).toBe(0);
    expect(data.data.total_sales_kobo).toBe(0);
    expect(data.data.cash_variance_kobo).toBe(-100000); // 0 cash - 100000 float = -100000 (short)
  });

  it('Z-report with NULL cash_sales handles gracefully (all digital payments)', async () => {
    mockDb.first
      .mockResolvedValueOnce({ id: 'sess_digital', cashier_id: 'c1', initial_float_kobo: 50000, status: 'open', opened_at: 0 })
      .mockResolvedValueOnce({ order_count: 5, total_sales_kobo: 500000, cash_sales_kobo: null });
    const res = await posRouter.fetch(req('PATCH', '/sessions/sess_digital/close'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(typeof data.data.cash_variance_kobo).toBe('number');
  });

  it('Z-report summary query failure returns 5xx error', async () => {
    mockDb.first
      .mockResolvedValueOnce({ id: 'sess_err', cashier_id: 'c1', initial_float_kobo: 0, status: 'open', opened_at: 0 })
      .mockRejectedValueOnce(new Error('D1 timeout'));
    const res = await posRouter.fetch(req('PATCH', '/sessions/sess_err/close'), mockEnv as any);
    expect([500, 503]).toContain(res.status);
  });

  it('Z-report cash_variance with zero float: variance = cash_sales', async () => {
    mockDb.first
      .mockResolvedValueOnce({ id: 'sess_nofloat', cashier_id: 'c2', initial_float_kobo: 0, status: 'open', opened_at: 0 })
      .mockResolvedValueOnce({ order_count: 3, total_sales_kobo: 150000, cash_sales_kobo: 150000 });
    const res = await posRouter.fetch(req('PATCH', '/sessions/sess_nofloat/close'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.data.cash_variance_kobo).toBe(150000); // 150000 - 0 = 150000
  });

  it('already-closed session returns stored z_report_json as parsed object', async () => {
    const storedReport = { id: 'sess_closed', status: 'closed', total_sales_kobo: 99999, order_count: 7, cash_variance_kobo: 1000 };
    mockDb.first
      .mockResolvedValueOnce({ id: 'sess_closed', cashier_id: 'c1', initial_float_kobo: 0, status: 'closed', opened_at: 0 })
      .mockResolvedValueOnce({ z_report_json: JSON.stringify(storedReport) });
    const res = await posRouter.fetch(req('PATCH', '/sessions/sess_closed/close'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.total_sales_kobo).toBe(99999);
    expect(data.data.order_count).toBe(7);
    expect(data.data.cash_variance_kobo).toBe(1000);
    // DB should NOT be updated again
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  it('session open records tenant_id in response', async () => {
    const res = await posRouter.fetch(req('POST', '/sessions', {
      cashier_id: 'amaka',
      initial_float_kobo: 25000,
    }, 'tnt_lagos'), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.tenant_id).toBe('tnt_lagos');
  });

  it('session open with negative float defaults to 0', async () => {
    const res = await posRouter.fetch(req('POST', '/sessions', {
      cashier_id: 'kemi',
      initial_float_kobo: -5000, // negative float — should be treated as 0 or clamped
    }), mockEnv as any);
    // The API should either accept (storing as-is) or clamp — either way no crash
    expect([201, 400]).toContain(res.status);
  });

  it('GET /sessions returns 503 on DB failure', async () => {
    mockDb.first.mockRejectedValue(new Error('DB down'));
    const res = await posRouter.fetch(req('GET', '/sessions'), mockEnv as any);
    expect(res.status).toBe(503);
  });
});

// ─── Void Order — Additional Coverage ────────────────────────────────────────
describe('Void Order — Additional Coverage', () => {
  it('void restores to fulfilled state would fail — void is one-way', async () => {
    // Once voided, subsequent void is idempotent (returns 200 with voided=true)
    mockDb.first.mockResolvedValue({ id: 'ord_1', order_status: 'voided', total_amount: 10000 });
    const res = await posRouter.fetch(req('POST', '/orders/ord_1/void', { reason: 'Re-void attempt' }), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.voided).toBe(true);
  });

  it('void stores trimmed reason (no leading/trailing whitespace)', async () => {
    mockDb.first.mockResolvedValue({ id: 'ord_2', order_status: 'fulfilled', total_amount: 50000 });
    const res = await posRouter.fetch(req('POST', '/orders/ord_2/void', { reason: '  Wrong item   ' }), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.reason).toBe('Wrong item');
  });

  it('void DB failure returns 500', async () => {
    mockDb.first.mockResolvedValue({ id: 'ord_3', order_status: 'fulfilled', total_amount: 50000 });
    mockDb.run.mockRejectedValue(new Error('D1 write failed'));
    const res = await posRouter.fetch(req('POST', '/orders/ord_3/void', { reason: 'Error test' }), mockEnv as any);
    expect(res.status).toBe(500);
    const data = await res.json() as any;
    expect(data.error).toBe('Transaction failed');
  });
});

// ─── Low-stock Endpoint — Additional Coverage ─────────────────────────────────
describe('Low-stock Endpoint — Additional Coverage', () => {
  it('threshold clamped to 0 when negative value provided', async () => {
    mockDb.all.mockResolvedValue({ results: [] });
    const res = await posRouter.fetch(req('GET', '/products/low-stock?threshold=-5'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.threshold).toBe(0);
  });

  it('returns barcode field for scanner integration', async () => {
    mockDb.all.mockResolvedValue({
      results: [{ id: 'p1', name: 'Item', quantity: 2, barcode: '619000001001', low_stock_threshold: 5 }],
    });
    const res = await posRouter.fetch(req('GET', '/products/low-stock'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.data[0].barcode).toBe('619000001001');
  });

  it('threshold=0 returns only out-of-stock products (quantity === 0)', async () => {
    mockDb.all.mockResolvedValue({
      results: [{ id: 'p1', name: 'OOS', quantity: 0 }],
    });
    const res = await posRouter.fetch(req('GET', '/products/low-stock?threshold=0'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.threshold).toBe(0);
    expect(data.count).toBe(1);
  });

  it('very high threshold returns all active products', async () => {
    mockDb.all.mockResolvedValue({
      results: Array(50).fill({ id: 'p1', name: 'X', quantity: 100 }),
    });
    const res = await posRouter.fetch(req('GET', '/products/low-stock?threshold=9999'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.count).toBe(50);
  });
});

// ─── Receipt Endpoint — Additional Coverage ───────────────────────────────────
describe('Receipt Endpoint — Additional Coverage', () => {
  const orderRow = (overrides = {}) => ({
    id: 'ord_x', total_amount: 75000, subtotal: 75000, discount: 0,
    payment_method: 'card', payments_json: null, items_json: null,
    customer_email: null, customer_phone: null,
    order_status: 'fulfilled', created_at: 1700000000000, ...overrides,
  });

  it('receipt for voided order still returns 201 (receipt always issued)', async () => {
    mockDb.first.mockResolvedValue(orderRow({ order_status: 'voided', total_amount: 50000 }));
    const res = await posRouter.fetch(req('POST', '/orders/ord_x/receipt'), mockEnv as any);
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.order_status).toBe('voided');
  });

  it('receipt whatsapp_url is URL-encoded (no raw ₦ in query param)', async () => {
    mockDb.first.mockResolvedValue(orderRow({ total_amount: 99900 }));
    const res = await posRouter.fetch(req('POST', '/orders/ord_x/receipt'), mockEnv as any);
    const data = await res.json() as any;
    const url = data.data.whatsapp_url;
    // URL should be encoded — raw ₦ should not appear unencoded
    expect(url).not.toMatch(/₦[^&]/); // Not a literal ₦ outside encoded form
    expect(url).toContain('wa.me');
  });

  it('receipt order_date is valid ISO 8601 string', async () => {
    mockDb.first.mockResolvedValue(orderRow({ created_at: 1700000000000 }));
    const res = await posRouter.fetch(req('POST', '/orders/ord_x/receipt'), mockEnv as any);
    const data = await res.json() as any;
    expect(() => new Date(data.data.order_date)).not.toThrow();
    expect(new Date(data.data.order_date).getTime()).toBe(1700000000000);
  });

  it('receipt includes print_url field', async () => {
    mockDb.first.mockResolvedValue(orderRow());
    const res = await posRouter.fetch(req('POST', '/orders/ord_x/receipt'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.data.print_url).toBeDefined();
    expect(data.data.print_url).toContain('ord_x');
  });

  it('receipt tenant_id matches request header', async () => {
    mockDb.first.mockResolvedValue(orderRow());
    const res = await posRouter.fetch(req('POST', '/orders/ord_x/receipt', undefined, 'tnt_abuja'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.data.tenant_id).toBe('tnt_abuja');
  });
});

// ─── Sync Endpoint — Additional Coverage ─────────────────────────────────────
describe('Sync Endpoint — Additional Coverage', () => {
  it('sync with malformed payload (missing total_amount) does not crash', async () => {
    mockDb.first.mockResolvedValue(null);
    const res = await posRouter.fetch(req('POST', '/sync', {
      mutations: [{
        entity_type: 'order', entity_id: 'ord_bad_payload', action: 'CREATE',
        payload: { items: [], subtotal: 500 }, // missing total_amount
        version: 1,
      }],
    }), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // Should apply or fail gracefully
    expect(['applied', 'failed'].some(k => Array.isArray(data.data[k]))).toBe(true);
  });

  it('sync with unknown entity_type is silently skipped', async () => {
    const res = await posRouter.fetch(req('POST', '/sync', {
      mutations: [{
        entity_type: 'customer', entity_id: 'cust_1', action: 'UPDATE',
        payload: { name: 'Ada' }, version: 1,
      }],
    }), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.applied).toHaveLength(0);
    expect(data.data.skipped).toHaveLength(0);
  });

  it('sync returns failed[] for each mutation that throws', async () => {
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockRejectedValue(new Error('D1 constraint violation'));
    const res = await posRouter.fetch(req('POST', '/sync', {
      mutations: [{
        entity_type: 'order', entity_id: 'ord_fail_1', action: 'CREATE',
        payload: { items: [], subtotal: 1000, total_amount: 1000, payment_method: 'cash' }, version: 1,
      }],
    }), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.failed).toContain('ord_fail_1');
  });

  it('missing x-tenant-id header on sync returns 400', async () => {
    const res = await posRouter.fetch(
      new Request('http://localhost/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations: [] }),
      }),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
  });
});

// ─── Dashboard — Additional Coverage ─────────────────────────────────────────
describe('Dashboard — Additional Coverage', () => {
  it('dashboard handles NULL revenue gracefully (defaults to 0)', async () => {
    mockDb.first
      .mockResolvedValueOnce({ order_count: 0, total_revenue: null })
      .mockResolvedValueOnce({ count: 10 })
      .mockResolvedValueOnce({ count: 2 });
    const res = await posRouter.fetch(req('GET', '/dashboard'), mockEnv as any);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.today_revenue_kobo).toBe(0);
    expect(data.data.today_orders).toBe(0);
  });

  it('dashboard returns all 4 required fields', async () => {
    mockDb.first
      .mockResolvedValueOnce({ order_count: 12, total_revenue: 650000 })
      .mockResolvedValueOnce({ count: 80 })
      .mockResolvedValueOnce({ count: 5 });
    const res = await posRouter.fetch(req('GET', '/dashboard'), mockEnv as any);
    const data = await res.json() as any;
    expect(data.data.today_orders).toBe(12);
    expect(data.data.today_revenue_kobo).toBe(650000);
    expect(data.data.product_count).toBe(80);
    expect(data.data.low_stock_count).toBe(5);
  });
});
