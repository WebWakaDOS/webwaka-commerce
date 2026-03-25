/**
 * COM-1: POS API Unit Tests — Phase 0 + Phase 1
 * L2 QA Layer: Unit tests for Point of Sale operations
 * Invariants: Multi-tenancy, Nigeria-First (kobo), Offline-First (sync), Stock correctness, PCI hardening
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posRouter, _resetRateLimitStore } from './api';

// ─── Mock D1 database ─────────────────────────────────────────────────────────
const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
  batch: vi.fn().mockResolvedValue([]),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {} };

function makeRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// Default batch helpers
const makeSufficientStockBatch = (qty = 100) => [
  { results: [{ id: 'prod_1', quantity: qty, name: 'Test Product' }], meta: { changes: 0 } },
];
const makeSuccessfulDeductBatch = (itemCount = 1) => [
  ...Array(itemCount).fill({ results: [], meta: { changes: 1 } }),
  { results: [], meta: { changes: 1 } }, // INSERT order
];

describe('COM-1: POS API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetRateLimitStore();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
    // Default batch: stock check (sufficient) + deduct (success)
    mockDb.batch
      .mockResolvedValueOnce(makeSufficientStockBatch(100))
      .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));
  });

  // ─── GET / ────────────────────────────────────────────────────────────────────
  describe('GET / (product list)', () => {
    it('should return product list for tenant', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', name: 'Jollof Rice', price: 250000 }] });
      const req = makeRequest('GET', '/');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return 400 if tenant ID is missing', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
      expect(data.error).toContain('tenant-id');
    });
  });

  // ─── GET /products ────────────────────────────────────────────────────────────
  describe('GET /products', () => {
    it('should list products with category filter', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', category: 'electronics' }] });
      const req = makeRequest('GET', '/products?category=electronics');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should list products with search filter', async () => {
      const req = makeRequest('GET', '/products?search=laptop');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return empty array when no products found', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/products');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
    });

    it('should respect limit and offset query params', async () => {
      const req = makeRequest('GET', '/products?limit=10&offset=20');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /products/barcode/:code ──────────────────────────────────────────────
  describe('GET /products/barcode/:code', () => {
    it('should return product when barcode matches', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_1', barcode: '123456789', name: 'Suya Spice' });
      const req = makeRequest('GET', '/products/barcode/123456789');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.barcode).toBe('123456789');
    });

    it('should return 404 when barcode not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/products/barcode/NOTFOUND');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });
  });

  // ─── POST /products ───────────────────────────────────────────────────────────
  describe('POST /products', () => {
    it('should create a product with valid data', async () => {
      const req = makeRequest('POST', '/products', {
        sku: 'SKU-001', name: 'Laptop', price: 500000, quantity: 10, category: 'electronics',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Laptop');
    });

    it('should store price as integer (kobo) — Nigeria-First invariant', async () => {
      const req = makeRequest('POST', '/products', {
        sku: 'SKU-002', name: 'Phone', price: 150000, quantity: 5,
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.price).toBe(150000);
    });

    it('should include tenant_id in created product', async () => {
      const req = makeRequest('POST', '/products', {
        sku: 'SKU-003', name: 'Chair', price: 25000, quantity: 3,
      }, 'tnt_abc');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.tenant_id).toBe('tnt_abc');
    });
  });

  // ─── GET /products/:id ────────────────────────────────────────────────────────
  describe('GET /products/:id', () => {
    it('should return 404 for non-existent product', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/products/prod_nonexistent');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return product when found', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_1', name: 'Laptop', price: 500000 });
      const req = makeRequest('GET', '/products/prod_1');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.id).toBe('prod_1');
    });
  });

  // ─── PATCH /products/:id ──────────────────────────────────────────────────────
  describe('PATCH /products/:id', () => {
    it('should update product fields', async () => {
      const req = makeRequest('PATCH', '/products/prod_1', { price: 45000, quantity: 8 });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return 400 if no valid fields provided', async () => {
      const req = makeRequest('PATCH', '/products/prod_1', { invalid_field: 'value' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /sessions ── Session / shift management ─────────────────────────────
  describe('POST /sessions (open shift)', () => {
    it('should open a session with cashier_id and initial float', async () => {
      const req = makeRequest('POST', '/sessions', {
        cashier_id: 'cashier_01',
        initial_float_kobo: 50000,
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.cashier_id).toBe('cashier_01');
      expect(data.data.initial_float_kobo).toBe(50000);
      expect(data.data.status).toBe('open');
      expect(data.data.id).toMatch(/^sess_/);
    });

    it('should default initial_float_kobo to 0 when not provided', async () => {
      const req = makeRequest('POST', '/sessions', { cashier_id: 'cashier_02' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.initial_float_kobo).toBe(0);
    });

    it('should return 400 if cashier_id is missing', async () => {
      const req = makeRequest('POST', '/sessions', { initial_float_kobo: 20000 });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('cashier_id');
    });

    it('should return 400 if cashier_id is an empty string', async () => {
      const req = makeRequest('POST', '/sessions', { cashier_id: '   ' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ─── GET /sessions ─────────────────────────────────────────────────────────────
  describe('GET /sessions (current open session)', () => {
    it('should return null when no session is open', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/sessions');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toBeNull();
    });

    it('should return the current open session', async () => {
      mockDb.first.mockResolvedValue({
        id: 'sess_abc',
        cashier_id: 'cashier_01',
        initial_float_kobo: 50000,
        status: 'open',
        opened_at: Date.now(),
      });
      const req = makeRequest('GET', '/sessions');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.id).toBe('sess_abc');
      expect(data.data.status).toBe('open');
    });
  });

  // ─── PATCH /sessions/:id/close ─────────────────────────────────────────────────
  describe('PATCH /sessions/:id/close (Z-report)', () => {
    it('should close a session and return a Z-report', async () => {
      // first() for session fetch
      mockDb.first
        .mockResolvedValueOnce({
          id: 'sess_xyz',
          cashier_id: 'cashier_01',
          initial_float_kobo: 50000,
          status: 'open',
          opened_at: Date.now() - 3600_000,
        })
        // second first() for sales summary
        .mockResolvedValueOnce({
          order_count: 10,
          total_sales_kobo: 500000,
          cash_sales_kobo: 300000,
        });

      const req = makeRequest('PATCH', '/sessions/sess_xyz/close');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('closed');
      expect(data.data.total_sales_kobo).toBe(500000);
      expect(data.data.order_count).toBe(10);
      expect(data.data.initial_float_kobo).toBe(50000);
    });

    it('should calculate cash variance correctly (cash_sales - initial_float)', async () => {
      // initial_float=50000, cash_sales=300000 → variance=250000
      mockDb.first
        .mockResolvedValueOnce({
          id: 'sess_xyz', cashier_id: 'c1', initial_float_kobo: 50000, status: 'open', opened_at: 0,
        })
        .mockResolvedValueOnce({
          order_count: 5, total_sales_kobo: 400000, cash_sales_kobo: 300000,
        });

      const req = makeRequest('PATCH', '/sessions/sess_xyz/close');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.cash_variance_kobo).toBe(250000); // 300000 - 50000
    });

    it('should return 404 if session does not exist', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('PATCH', '/sessions/nonexistent/close');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should be idempotent — already closed returns 200 with report', async () => {
      const storedReport = JSON.stringify({ id: 'sess_xyz', status: 'closed', total_sales_kobo: 200000 });
      mockDb.first
        .mockResolvedValueOnce({
          id: 'sess_xyz', cashier_id: 'c1', initial_float_kobo: 0, status: 'closed', opened_at: 0,
        })
        .mockResolvedValueOnce({ z_report_json: storedReport });

      const req = makeRequest('PATCH', '/sessions/sess_xyz/close');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.total_sales_kobo).toBe(200000);
    });
  });

  // ─── POST /checkout — Phase 0 tests (backward compat) ────────────────────────
  describe('POST /checkout (single payment_method — backward compat)', () => {
    it('should process a POS sale with payment_method field', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 2, price: 50000, name: 'Test' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.payment_status).toBe('paid');
    });

    it('should calculate total correctly (kobo arithmetic) — Nigeria-First invariant', async () => {
      mockDb.batch.mockReset();
      mockDb.batch
        .mockResolvedValueOnce([
          { results: [{ id: 'prod_1', quantity: 100, name: 'A' }], meta: { changes: 0 } },
          { results: [{ id: 'prod_2', quantity: 100, name: 'B' }], meta: { changes: 0 } },
        ])
        .mockResolvedValueOnce(makeSuccessfulDeductBatch(2));

      const req = makeRequest('POST', '/checkout', {
        items: [
          { product_id: 'prod_1', quantity: 2, price: 50000, name: 'Item A' },
          { product_id: 'prod_2', quantity: 1, price: 30000, name: 'Item B' },
        ],
        payment_method: 'card',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(130000); // 2×50000 + 1×30000
    });

    it('should apply discount correctly', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payment_method: 'cash',
        discount: 10000,
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(90000); // 100000 - 10000
    });

    it('should mark order as fulfilled immediately (POS channel)', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'Item' }],
        payment_method: 'transfer',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.order_status).toBe('fulfilled');
    });

    it('should return 400 for empty cart', async () => {
      const req = makeRequest('POST', '/checkout', { items: [], payment_method: 'cash' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('empty');
    });

    it('should return 400 for invalid payment method', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
        payment_method: 'bitcoin',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('Invalid payment method');
    });

    it('should accept all valid Nigerian payment methods', async () => {
      for (const method of ['cash', 'card', 'transfer', 'cod', 'agency_banking']) {
        vi.clearAllMocks();
        mockDb.prepare.mockReturnThis();
        mockDb.bind.mockReturnThis();
        mockDb.run.mockResolvedValue({ success: true });
        mockDb.batch
          .mockResolvedValueOnce(makeSufficientStockBatch(100))
          .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));

        const req = makeRequest('POST', '/checkout', {
          items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
          payment_method: method,
        });
        const res = await posRouter.fetch(req, mockEnv as any);
        expect(res.status, `Expected 201 for method ${method}`).toBe(201);
      }
    });

    it('should return 409 when stock is insufficient — oversell prevention', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 1, name: 'Suya Spice' }], meta: { changes: 0 } },
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 5, price: 10000, name: 'Suya Spice' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.insufficient_items[0].available).toBe(1);
      expect(data.insufficient_items[0].requested).toBe(5);
    });

    it('should return 409 when stock is exactly zero', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 0, name: 'OOS' }], meta: { changes: 0 } },
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 5000, name: 'OOS' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
    });

    it('should return 404 when product does not exist at checkout', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([{ results: [], meta: { changes: 0 } }]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_ghost', quantity: 1, price: 5000, name: 'Ghost' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should call D1 batch twice on successful checkout (stock check + deduct)', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 3, price: 50000, name: 'Test' }],
        payment_method: 'cash',
      });
      await posRouter.fetch(req, mockEnv as any);
      expect(mockDb.batch).toHaveBeenCalledTimes(2);
    });

    it('should NOT deduct inventory when stock validation fails', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 2, name: 'Item' }], meta: { changes: 0 } },
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 10, price: 5000, name: 'Item' }],
        payment_method: 'cash',
      });
      await posRouter.fetch(req, mockEnv as any);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('should return 409 STOCK_RACE when concurrent checkout wins', async () => {
      mockDb.batch.mockReset();
      mockDb.batch
        .mockResolvedValueOnce([
          { results: [{ id: 'prod_1', quantity: 10, name: 'Last Unit' }], meta: { changes: 0 } },
        ])
        .mockResolvedValueOnce([
          { results: [], meta: { changes: 0 } }, // UPDATE matched 0 rows
          { results: [], meta: { changes: 1 } },
        ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 10, price: 5000, name: 'Last Unit' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STOCK_RACE');
    });

    it('should report all insufficient items in multi-item cart', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 5, name: 'Item A' }], meta: { changes: 0 } },
        { results: [{ id: 'prod_2', quantity: 0, name: 'Item B' }], meta: { changes: 0 } },
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [
          { product_id: 'prod_1', quantity: 10, price: 5000, name: 'Item A' },
          { product_id: 'prod_2', quantity: 1, price: 3000, name: 'Item B' },
        ],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.insufficient_items).toHaveLength(2);
    });

    it('should return order id with prefix ord_pos_', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'Item' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.id).toMatch(/^ord_pos_/);
    });
  });

  // ─── POST /checkout — Phase 1: split payments ─────────────────────────────────
  describe('POST /checkout (split payments)', () => {
    it('should process checkout with payments[] array (single cash)', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payments: [{ method: 'cash', amount_kobo: 100000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.total_amount).toBe(100000);
      expect(data.data.payment_method).toBe('cash');
    });

    it('should process split cash + card checkout and return payment_method = split', async () => {
      mockDb.batch.mockReset();
      mockDb.batch
        .mockResolvedValueOnce(makeSufficientStockBatch(100))
        .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));

      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payments: [
          { method: 'cash', amount_kobo: 60000 },
          { method: 'card', amount_kobo: 40000 },
        ],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.payment_method).toBe('split');
      expect(data.data.payments).toHaveLength(2);
    });

    it('should generate Paystack reference for card payment', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'Item' }],
        payments: [{ method: 'card', amount_kobo: 50000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^PAY_/);
    });

    it('should generate Paystack reference for transfer payment', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 75000, name: 'Item' }],
        payments: [{ method: 'transfer', amount_kobo: 75000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^PAY_/);
    });

    it('should return 400 when payments total does not match order total', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce(makeSufficientStockBatch(100));

      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payments: [
          { method: 'cash', amount_kobo: 50000 },
          { method: 'card', amount_kobo: 30000 }, // under-pays by 20000
        ],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('does not match');
    });

    it('should return 400 when no payment info provided at all', async () => {
      mockDb.batch.mockReset();
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'Item' }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('Payment information required');
    });

    it('should return 400 when a payment method in payments[] is invalid', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'Item' }],
        payments: [{ method: 'crypto', amount_kobo: 10000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });

    it('should accept pre-supplied payment reference without replacing it', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'Item' }],
        payments: [{ method: 'card', amount_kobo: 50000, reference: 'EXISTING_REF_123' }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      const cardPayment = data.data.payments?.find((p: any) => p.method === 'card');
      expect(cardPayment?.reference).toBe('EXISTING_REF_123');
    });
  });

  // ─── POST /checkout — Phase 1: rate limiting ──────────────────────────────────
  describe('POST /checkout (rate limiting)', () => {
    it('should return 429 after 10 requests in 1 minute per session_id', async () => {
      const makeCheckout = () =>
        makeRequest('POST', '/checkout', {
          line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
          payments: [{ method: 'cash', amount_kobo: 10000 }],
          session_id: 'sess_ratelimit_test',
        });

      // First 10 requests should succeed — set up mocks for 10 rounds
      for (let i = 0; i < 10; i++) {
        mockDb.batch
          .mockResolvedValueOnce(makeSufficientStockBatch(500))
          .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));
        const res = await posRouter.fetch(makeCheckout(), mockEnv as any);
        expect(res.status, `Request ${i + 1} should be 201`).toBe(201);
      }

      // 11th request: rate limited (no DB call needed — rejected before stock check)
      const res = await posRouter.fetch(makeCheckout(), mockEnv as any);
      expect(res.status).toBe(429);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
    });

    it('should NOT rate limit when no session_id is provided', async () => {
      // Without session_id, rate limiting is skipped (uses payment_method compat)
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
        payments: [{ method: 'cash', amount_kobo: 10000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should allow requests under the rate limit threshold', async () => {
      // 5 requests with the same session_id — all should succeed
      for (let i = 0; i < 5; i++) {
        mockDb.batch
          .mockResolvedValueOnce(makeSufficientStockBatch(500))
          .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));
        const req = makeRequest('POST', '/checkout', {
          line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
          payments: [{ method: 'cash', amount_kobo: 10000 }],
          session_id: 'sess_under_limit',
        });
        const res = await posRouter.fetch(req, mockEnv as any);
        expect(res.status).toBe(201);
      }
    });
  });

  // ─── POST /orders/:id/void ────────────────────────────────────────────────────
  describe('POST /orders/:id/void', () => {
    it('should void an order with a reason', async () => {
      mockDb.first.mockResolvedValue({
        id: 'ord_pos_1', order_status: 'fulfilled', total_amount: 50000,
      });
      const req = makeRequest('POST', '/orders/ord_pos_1/void', { reason: 'Customer changed mind' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.voided).toBe(true);
      expect(data.data.order_status).toBe('voided');
      expect(data.data.reason).toBe('Customer changed mind');
    });

    it('should return 400 when reason is missing', async () => {
      const req = makeRequest('POST', '/orders/ord_pos_1/void', {});
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('reason');
    });

    it('should return 400 when reason is an empty string', async () => {
      const req = makeRequest('POST', '/orders/ord_pos_1/void', { reason: '   ' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });

    it('should return 404 when order does not exist', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/orders/nonexistent/void', { reason: 'Duplicate' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should be idempotent — voiding an already-voided order returns 200', async () => {
      mockDb.first.mockResolvedValue({
        id: 'ord_pos_1', order_status: 'voided', total_amount: 50000,
      });
      const req = makeRequest('POST', '/orders/ord_pos_1/void', { reason: 'Duplicate void' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.voided).toBe(true);
      // DB update should NOT be called again for idempotent void
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  // ─── GET /orders ──────────────────────────────────────────────────────────────
  describe('GET /orders', () => {
    it('should list POS orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'pos' }] });
      const req = makeRequest('GET', '/orders');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should respect limit and offset for pagination', async () => {
      const req = makeRequest('GET', '/orders?limit=25&offset=50');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ─── POST /sync — Offline-First invariant ─────────────────────────────────────
  describe('POST /sync — Offline-First invariant', () => {
    it('should accept offline sync mutations', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/sync', {
        mutations: [{
          entity_type: 'order', entity_id: 'ord_offline_1', action: 'CREATE',
          payload: { items: [], subtotal: 50000, total_amount: 50000, payment_method: 'cash' },
          version: 1,
        }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.applied).toContain('ord_offline_1');
    });

    it('should skip already-synced mutations — idempotency invariant', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_sync_already' });
      const req = makeRequest('POST', '/sync', {
        mutations: [{
          entity_type: 'order', entity_id: 'ord_offline_dup', action: 'CREATE',
          payload: { items: [], subtotal: 5000, total_amount: 5000, payment_method: 'cash' }, version: 1,
        }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.applied).toHaveLength(0);
      expect(data.data.skipped).toContain('ord_offline_dup');
    });

    it('should apply multiple mutations and report each', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/sync', {
        mutations: [
          { entity_type: 'order', entity_id: 'ord_a', action: 'CREATE', payload: { items: [], subtotal: 1000, total_amount: 1000, payment_method: 'cash' }, version: 1 },
          { entity_type: 'order', entity_id: 'ord_b', action: 'CREATE', payload: { items: [], subtotal: 2000, total_amount: 2000, payment_method: 'transfer' }, version: 1 },
        ],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.applied).toHaveLength(2);
    });

    it('should handle empty mutations array gracefully', async () => {
      const req = makeRequest('POST', '/sync', { mutations: [] });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.applied).toHaveLength(0);
    });
  });

  // ─── GET /dashboard ───────────────────────────────────────────────────────────
  describe('GET /dashboard', () => {
    it('should return sales summary with all expected fields', async () => {
      mockDb.first
        .mockResolvedValueOnce({ order_count: 5, total_revenue: 250000 })
        .mockResolvedValueOnce({ count: 20 })
        .mockResolvedValueOnce({ count: 3 });
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveProperty('today_orders');
      expect(data.data).toHaveProperty('today_revenue_kobo');
      expect(data.data).toHaveProperty('product_count');
      expect(data.data).toHaveProperty('low_stock_count');
    });

    it('should return 503 when DB is unavailable — not silent zeros', async () => {
      mockDb.first.mockRejectedValue(new Error('D1 connection timeout'));
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(503);
    });
  });

  // ─── Multi-tenancy isolation ─────────────────────────────────────────────────
  describe('Multi-tenancy isolation', () => {
    it('should isolate product data between tenants', async () => {
      const req1 = makeRequest('GET', '/products', undefined, 'tenant_A');
      const req2 = makeRequest('GET', '/products', undefined, 'tenant_B');
      const [res1, res2] = await Promise.all([
        posRouter.fetch(req1, mockEnv as any),
        posRouter.fetch(req2, mockEnv as any),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('should reject requests without tenant header', async () => {
      const req = new Request('http://localhost/products', { method: 'GET' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });

    it('should use tenant_id in checkout stock validation', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
        payment_method: 'cash',
      }, 'tnt_isolate');
      await posRouter.fetch(req, mockEnv as any);
      expect(mockDb.bind).toHaveBeenCalledWith('prod_1', 'tnt_isolate');
    });
  });
});
