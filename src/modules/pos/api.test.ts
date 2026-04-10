/**
 * COM-1: POS API Unit Tests — Phase 0 + Phase 1 + Phase 2
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
  run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
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

// ─── Batch helpers ────────────────────────────────────────────────────────────
const makeSufficientStockBatch = (qty = 100) => [
  { results: [{ id: 'prod_1', quantity: qty, name: 'Test Product', version: 1 }], meta: { changes: 0 } },
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
    mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
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

  // ─── GET /cmrc_products ────────────────────────────────────────────────────────────
  describe('GET /cmrc_products', () => {
    it('should list cmrc_products with category filter', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', category: 'electronics' }] });
      const req = makeRequest('GET', '/cmrc_products?category=electronics');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should list cmrc_products with search filter', async () => {
      const req = makeRequest('GET', '/cmrc_products?search=laptop');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return empty array when no cmrc_products found', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/cmrc_products');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
    });

    it('should respect limit and offset query params', async () => {
      const req = makeRequest('GET', '/cmrc_products?limit=10&offset=20');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ─── GET /cmrc_products/barcode/:code ──────────────────────────────────────────────
  describe('GET /cmrc_products/barcode/:code', () => {
    it('should return product when barcode matches', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_1', barcode: '123456789', name: 'Suya Spice', price: 5000, quantity: 20 });
      const req = makeRequest('GET', '/cmrc_products/barcode/123456789');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.barcode).toBe('123456789');
    });

    it('should return 404 when barcode not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/cmrc_products/barcode/NOTFOUND');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return product SKU in addition to barcode', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_1', barcode: 'ABC001', sku: 'SKU-001', name: 'Pepper', price: 2000, quantity: 50 });
      const req = makeRequest('GET', '/cmrc_products/barcode/ABC001');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.sku).toBe('SKU-001');
      expect(data.data.price).toBe(2000);
    });

    it('should match product by SKU (barcode fallback)', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_2', barcode: null, sku: 'SKU-999', name: 'Salt', price: 500, quantity: 100 });
      const req = makeRequest('GET', '/cmrc_products/barcode/SKU-999');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.sku).toBe('SKU-999');
    });

    it('should return product quantity so caller can validate stock', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_3', barcode: 'XYZ-001', name: 'Oil', price: 15000, quantity: 3 });
      const req = makeRequest('GET', '/cmrc_products/barcode/XYZ-001');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(typeof data.data.quantity).toBe('number');
    });
  });

  // ─── GET /cmrc_products/low-stock (Phase 2) ───────────────────────────────────────
  describe('GET /cmrc_products/low-stock — reorder alerts (Phase 2)', () => {
    it('should return cmrc_products at or below default threshold (10)', async () => {
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'prod_a', name: 'Yam Flour', quantity: 2, low_stock_threshold: 5 },
          { id: 'prod_b', name: 'Palm Oil', quantity: 8, low_stock_threshold: 10 },
        ],
      });
      const req = makeRequest('GET', '/cmrc_products/low-stock');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
      expect(data.threshold).toBe(10);
    });

    it('should use threshold query param to override default', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_a', name: 'Garri', quantity: 3 }] });
      const req = makeRequest('GET', '/cmrc_products/low-stock?threshold=5');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.threshold).toBe(5);
    });

    it('should return empty array when no cmrc_products are low stock', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/cmrc_products/low-stock');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('should include count field in response', async () => {
      mockDb.all.mockResolvedValue({
        results: [{ id: 'p1', name: 'Banga Soup', quantity: 1 }],
      });
      const req = makeRequest('GET', '/cmrc_products/low-stock');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.count).toBe(1);
    });

    it('should return 503 when DB is unavailable', async () => {
      mockDb.all.mockRejectedValue(new Error('D1 timeout'));
      const req = makeRequest('GET', '/cmrc_products/low-stock');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(503);
    });

    it('should return 400 when tenant ID is missing', async () => {
      const req = new Request('http://localhost/cmrc_products/low-stock', { method: 'GET' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /cmrc_products ───────────────────────────────────────────────────────────
  describe('POST /cmrc_products', () => {
    it('should create a product with valid data', async () => {
      const req = makeRequest('POST', '/cmrc_products', {
        sku: 'SKU-001', name: 'Laptop', price: 500000, quantity: 10, category: 'electronics',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.name).toBe('Laptop');
    });

    it('should store price as integer (kobo) — Nigeria-First invariant', async () => {
      const req = makeRequest('POST', '/cmrc_products', {
        sku: 'SKU-002', name: 'Phone', price: 150000, quantity: 5,
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.price).toBe(150000);
    });

    it('should include tenant_id in created product', async () => {
      const req = makeRequest('POST', '/cmrc_products', {
        sku: 'SKU-003', name: 'Chair', price: 25000, quantity: 3,
      }, 'tnt_abc');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.tenant_id).toBe('tnt_abc');
    });
  });

  // ─── GET /cmrc_products/:id ────────────────────────────────────────────────────────
  describe('GET /cmrc_products/:id', () => {
    it('should return 404 for non-existent product', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/cmrc_products/prod_nonexistent');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return product when found', async () => {
      mockDb.first.mockResolvedValue({ id: 'prod_1', name: 'Laptop', price: 500000 });
      const req = makeRequest('GET', '/cmrc_products/prod_1');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.id).toBe('prod_1');
    });
  });

  // ─── PATCH /cmrc_products/:id ──────────────────────────────────────────────────────
  describe('PATCH /cmrc_products/:id', () => {
    it('should update product fields', async () => {
      const req = makeRequest('PATCH', '/cmrc_products/prod_1', { price: 45000, quantity: 8 });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return 400 if no valid fields provided', async () => {
      const req = makeRequest('PATCH', '/cmrc_products/prod_1', { invalid_field: 'value' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /sessions ───────────────────────────────────────────────────────────
  describe('POST /sessions (open shift)', () => {
    it('should open a session with cashier_id and initial float', async () => {
      const req = makeRequest('POST', '/sessions', {
        cashier_id: 'cashier_01', initial_float_kobo: 50000,
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
        id: 'sess_abc', cashier_id: 'cashier_01',
        initial_float_kobo: 50000, status: 'open', opened_at: Date.now(),
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
      mockDb.first
        .mockResolvedValueOnce({ id: 'sess_xyz', cashier_id: 'cashier_01', initial_float_kobo: 50000, status: 'open', opened_at: Date.now() - 3600_000 })
        .mockResolvedValueOnce({ order_count: 10, total_sales_kobo: 500000, cash_sales_kobo: 300000 });
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
      mockDb.first
        .mockResolvedValueOnce({ id: 'sess_xyz', cashier_id: 'c1', initial_float_kobo: 50000, status: 'open', opened_at: 0 })
        .mockResolvedValueOnce({ order_count: 5, total_sales_kobo: 400000, cash_sales_kobo: 300000 });
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
        .mockResolvedValueOnce({ id: 'sess_xyz', cashier_id: 'c1', initial_float_kobo: 0, status: 'closed', opened_at: 0 })
        .mockResolvedValueOnce({ z_report_json: storedReport });
      const req = makeRequest('PATCH', '/sessions/sess_xyz/close');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.total_sales_kobo).toBe(200000);
    });
  });

  // ─── POST /checkout — backward compat ─────────────────────────────────────────
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
          { results: [{ id: 'prod_1', quantity: 100, name: 'A', version: 1 }], meta: { changes: 0 } },
          { results: [{ id: 'prod_2', quantity: 100, name: 'B', version: 1 }], meta: { changes: 0 } },
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
      expect(data.data.total_amount).toBe(130000);
    });

    it('should apply discount correctly', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payment_method: 'cash', discount: 10000,
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
    });

    it('should accept all valid Nigerian payment methods', async () => {
      for (const method of ['cash', 'card', 'transfer', 'cod', 'agency_banking']) {
        vi.clearAllMocks();
        mockDb.prepare.mockReturnThis();
        mockDb.bind.mockReturnThis();
        mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
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

    it('should return 409 when stock is insufficient', async () => {
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

    it('should call D1 batch twice on successful checkout', async () => {
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
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 10, name: 'Last Unit', version: 1 }], meta: { changes: 0 } },
      ]);
      // Simulate optimistic lock conflict: another terminal already updated this row
      mockDb.run.mockResolvedValueOnce({ success: true, meta: { changes: 0 } });
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

  // ─── POST /checkout — split payments ─────────────────────────────────────────
  describe('POST /checkout (split payments)', () => {
    it('should process checkout with payments[] array (single cash)', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'Item' }],
        payments: [{ method: 'cash', amount_kobo: 100000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(100000);
      expect(data.data.payment_method).toBe('cash');
    });

    it('should process split cash + card and return payment_method = split', async () => {
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
          { method: 'card', amount_kobo: 30000 },
        ],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('does not match');
    });

    it('should return 400 when no payment info provided', async () => {
      mockDb.batch.mockReset();
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'Item' }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('Payment information required');
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

  // ─── POST /checkout — rate limiting ──────────────────────────────────────────
  describe('POST /checkout (rate limiting)', () => {
    it('should return 429 after 10 requests per session_id', async () => {
      const makeCheckout = () =>
        makeRequest('POST', '/checkout', {
          line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
          payments: [{ method: 'cash', amount_kobo: 10000 }],
          session_id: 'sess_ratelimit_test',
        });
      for (let i = 0; i < 10; i++) {
        mockDb.batch
          .mockResolvedValueOnce(makeSufficientStockBatch(500))
          .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));
        const res = await posRouter.fetch(makeCheckout(), mockEnv as any);
        expect(res.status, `Request ${i + 1} should be 201`).toBe(201);
      }
      const res = await posRouter.fetch(makeCheckout(), mockEnv as any);
      expect(res.status).toBe(429);
    });

    it('should NOT rate limit without session_id', async () => {
      const req = makeRequest('POST', '/checkout', {
        line_items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'X' }],
        payments: [{ method: 'cash', amount_kobo: 10000 }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should allow requests under the rate limit threshold', async () => {
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

  // ─── POST /cmrc_orders/:id/void ────────────────────────────────────────────────────
  describe('POST /cmrc_orders/:id/void', () => {
    it('should void an order with a reason', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_pos_1', order_status: 'fulfilled', total_amount: 50000 });
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_1/void', { reason: 'Customer changed mind' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.voided).toBe(true);
      expect(data.data.order_status).toBe('voided');
      expect(data.data.reason).toBe('Customer changed mind');
    });

    it('should return 400 when reason is missing', async () => {
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_1/void', {});
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('reason');
    });

    it('should return 400 when reason is empty string', async () => {
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_1/void', { reason: '   ' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });

    it('should return 404 when order does not exist', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/cmrc_orders/nonexistent/void', { reason: 'Duplicate' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should be idempotent — voiding an already-voided order returns 200', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_pos_1', order_status: 'voided', total_amount: 50000 });
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_1/void', { reason: 'Duplicate void' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.voided).toBe(true);
      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });

  // ─── POST /cmrc_orders/:id/receipt (Phase 2) ──────────────────────────────────────
  describe('POST /cmrc_orders/:id/receipt — receipt generation (Phase 2)', () => {
    const makeOrderRow = (overrides = {}) => ({
      id: 'ord_pos_abc',
      total_amount: 150000,
      subtotal: 160000,
      discount: 10000,
      payment_method: 'cash',
      payments_json: JSON.stringify([{ method: 'cash', amount_kobo: 150000 }]),
      items_json: JSON.stringify([{ product_id: 'p1', name: 'Beans', quantity: 3, price: 50000 }]),
      customer_email: 'buyer@example.com',
      customer_phone: '+2348012345678',
      order_status: 'fulfilled',
      created_at: 1700000000000,
      ...overrides,
    });

    it('should return 201 with full receipt JSON', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow());
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should have receipt_id prefixed with RCP_', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow());
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.receipt_id).toBe('RCP_ord_pos_abc');
    });

    it('should include total in both kobo and naira string', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow({ total_amount: 150000 }));
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.total_kobo).toBe(150000);
      expect(data.data.total_naira).toBe('1500.00');
    });

    it('should include whatsapp_url with wa.me domain', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow());
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.whatsapp_url).toContain('wa.me');
      expect(data.data.whatsapp_url).toContain('RCP_ord_pos_abc');
    });

    it('should parse items_json into array', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow());
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(Array.isArray(data.data.items)).toBe(true);
      expect(data.data.items[0].name).toBe('Beans');
    });

    it('should include issued_at timestamp (number)', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow());
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(typeof data.data.issued_at).toBe('number');
      expect(data.data.issued_at).toBeGreaterThan(0);
    });

    it('should include subtotal_kobo and discount_kobo', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow({ subtotal: 160000, discount: 10000 }));
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.subtotal_kobo).toBe(160000);
      expect(data.data.discount_kobo).toBe(10000);
    });

    it('should return 404 for non-existent order', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/cmrc_orders/ord_ghost/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toContain('not found');
    });

    it('should return 503 when DB is unavailable', async () => {
      mockDb.first.mockRejectedValue(new Error('D1 timeout'));
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(503);
    });

    it('should handle null items_json gracefully (returns empty array)', async () => {
      mockDb.first.mockResolvedValue(makeOrderRow({ items_json: null, payments_json: null }));
      const req = makeRequest('POST', '/cmrc_orders/ord_pos_abc/receipt');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.items).toEqual([]);
      expect(data.data.payments).toEqual([]);
    });
  });

  // ─── GET /cmrc_orders ──────────────────────────────────────────────────────────────
  describe('GET /cmrc_orders', () => {
    it('should list POS cmrc_orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'pos' }] });
      const req = makeRequest('GET', '/cmrc_orders');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should respect limit and offset for pagination', async () => {
      const req = makeRequest('GET', '/cmrc_orders?limit=25&offset=50');
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

    it('should isolate a failed mutation — others still apply', async () => {
      // First call: ord_c not found → apply; second call: DB error → fail
      mockDb.first
        .mockResolvedValueOnce(null)   // ord_c: not existing → apply
        .mockResolvedValueOnce(null);  // ord_d: not existing → attempt apply
      mockDb.run
        .mockResolvedValueOnce({ success: true }) // ord_c INSERT ok
        .mockRejectedValueOnce(new Error('D1 error')); // ord_d INSERT fails

      const req = makeRequest('POST', '/sync', {
        mutations: [
          { entity_type: 'order', entity_id: 'ord_c', action: 'CREATE', payload: { items: [], subtotal: 1000, total_amount: 1000, payment_method: 'cash' }, version: 1 },
          { entity_type: 'order', entity_id: 'ord_d', action: 'CREATE', payload: { items: [], subtotal: 2000, total_amount: 2000, payment_method: 'cash' }, version: 1 },
        ],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.applied).toContain('ord_c');
      expect(data.data.failed).toContain('ord_d');
    });

    it('should include synced_at timestamp in response', async () => {
      const before = Date.now();
      const req = makeRequest('POST', '/sync', { mutations: [] });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.synced_at).toBeGreaterThanOrEqual(before);
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

    it('should return 503 when DB is unavailable', async () => {
      mockDb.first.mockRejectedValue(new Error('D1 connection timeout'));
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(503);
    });
  });

  // ─── T-COM-01: Micro-Hub Outlet CRUD ─────────────────────────────────────────
  describe('T-COM-01: Micro-Hub Outlet CRUD', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      _resetRateLimitStore();
      mockDb.prepare.mockReturnThis();
      mockDb.bind.mockReturnThis();
      mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
      mockDb.first.mockResolvedValue(null);
      mockDb.all.mockResolvedValue({ results: [] });
      mockDb.batch.mockResolvedValue([]);
    });

    it('POST /outlets rejects missing name', async () => {
      const req = makeRequest('POST', '/outlets', { address: 'Lagos Island' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/name/i);
    });

    it('POST /outlets creates outlet and returns 201', async () => {
      const req = makeRequest('POST', '/outlets', { name: 'Victoria Island Hub', address: 'VI Lagos', lat: 6.4281, lng: 3.4219 });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const body = await res.json() as { success: boolean; data: { name: string; lat: number } };
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('Victoria Island Hub');
      expect(body.data.lat).toBe(6.4281);
    });

    it('POST /outlets trims name whitespace', async () => {
      const req = makeRequest('POST', '/outlets', { name: '  Ikeja Hub  ' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const body = await res.json() as { success: boolean; data: { name: string } };
      expect(body.data.name).toBe('Ikeja Hub');
    });

    it('GET /outlets returns list for tenant', async () => {
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'out_1', name: 'VI Hub', address: 'VI Lagos', lat: 6.43, lng: 3.42, active: 1, created_at: '2026-01-01' },
        ],
      });
      const req = makeRequest('GET', '/outlets');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: unknown[] };
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('PATCH /outlets/:id returns 404 for unknown outlet', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('PATCH', '/outlets/out_unknown', { name: 'New Name' });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('PATCH /outlets/:id updates outlet', async () => {
      mockDb.first.mockResolvedValue({ id: 'out_1' });
      const req = makeRequest('PATCH', '/outlets/out_1', { name: 'Updated Hub', active: false });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { updated: boolean } };
      expect(body.success).toBe(true);
      expect(body.data.updated).toBe(true);
    });

    it('GET /outlets enforces tenant isolation via bind', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/outlets', undefined, 'tnt_alpha');
      await posRouter.fetch(req, mockEnv as any);
      expect(mockDb.bind).toHaveBeenCalledWith('tnt_alpha');
    });
  });

  // ─── T-COM-01: Fulfillment Queue ─────────────────────────────────────────────
  describe('T-COM-01: Fulfillment Queue', () => {
    beforeEach(() => {
      vi.resetAllMocks();
      _resetRateLimitStore();
      mockDb.prepare.mockReturnThis();
      mockDb.bind.mockReturnThis();
      mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
      mockDb.first.mockResolvedValue(null);
      mockDb.all.mockResolvedValue({ results: [] });
      mockDb.batch.mockResolvedValue([]);
    });

    it('GET /fulfillment-queue requires outlet_id param', async () => {
      const req = makeRequest('GET', '/fulfillment-queue');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toMatch(/outlet_id/i);
    });

    it('GET /fulfillment-queue returns assigned cmrc_orders for outlet', async () => {
      mockDb.all.mockResolvedValue({
        results: [{
          id: 'ord_sv_1',
          customer_phone: '08012345678',
          customer_email: null,
          items_json: '[{"product_id":"p1","name":"Bag","quantity":2,"price":5000}]',
          total_amount: 10000,
          fulfillment_status: 'assigned',
          fulfillment_assigned_at: '2026-01-01T10:00:00Z',
          delivery_address_json: '{"state":"Lagos","lga":"VI","street":"Ozumba Mbadiwe"}',
        }],
      });
      const req = makeRequest('GET', '/fulfillment-queue?outlet_id=out_1');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: Array<{ id: string; items: unknown[] }> };
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.id).toBe('ord_sv_1');
      expect(Array.isArray(body.data[0]!.items)).toBe(true);
    });

    it('GET /fulfillment-queue enforces tenant isolation', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/fulfillment-queue?outlet_id=out_1', undefined, 'tnt_beta');
      await posRouter.fetch(req, mockEnv as any);
      expect(mockDb.bind).toHaveBeenCalledWith('tnt_beta', 'out_1');
    });

    it('PATCH /fulfillment-queue/:id/start rejects 404 for unknown order', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_unknown/start');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('PATCH /fulfillment-queue/:id/start rejects wrong state', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_sv_1', fulfillment_status: 'picking' });
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_sv_1/start');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toMatch(/picking/);
    });

    it('PATCH /fulfillment-queue/:id/start transitions assigned → picking', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_sv_1', fulfillment_status: 'assigned' });
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_sv_1/start');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { fulfillment_status: string } };
      expect(body.success).toBe(true);
      expect(body.data.fulfillment_status).toBe('picking');
    });

    it('PATCH /fulfillment-queue/:id/packed rejects wrong state (not picking)', async () => {
      mockDb.first.mockResolvedValue({ id: 'ord_sv_2', fulfillment_status: 'assigned', fulfillment_outlet_id: 'out_1', total_amount: 5000, items_json: '[]', delivery_address_json: null });
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_sv_2/packed');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const body = await res.json() as { success: boolean; error: string };
      expect(body.error).toMatch(/start picking/i);
    });

    it('PATCH /fulfillment-queue/:id/packed emits ORDER_PACKED and ORDER_READY_DELIVERY events', async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const envWithQueue = { ...mockEnv, COMMERCE_EVENTS: mockQueue };
      mockDb.first
        .mockResolvedValueOnce({ id: 'ord_sv_3', fulfillment_status: 'picking', fulfillment_outlet_id: 'out_1', total_amount: 20000, items_json: '[{"name":"Bag","quantity":1}]', delivery_address_json: null })
        .mockResolvedValueOnce({ name: 'VI Hub', address: 'VI Lagos', lat: 6.43, lng: 3.42 });
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_sv_3/packed');
      const res = await posRouter.fetch(req, envWithQueue as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { events_emitted: string[] } };
      expect(body.success).toBe(true);
      expect(body.data.events_emitted).toContain('order.packed');
      expect(body.data.events_emitted).toContain('order.ready_for_delivery');
      expect(mockQueue.send).toHaveBeenCalledTimes(2);
      const eventTypes = (mockQueue.send.mock.calls as Array<[{ type: string }]>).map(c => c[0].type);
      expect(eventTypes).toContain('order.packed');
      expect(eventTypes).toContain('order.ready_for_delivery');
    });

    it('PATCH /fulfillment-queue/:id/packed response includes fulfillment_packed_at', async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const envWithQueue = { ...mockEnv, COMMERCE_EVENTS: mockQueue };
      mockDb.first
        .mockResolvedValueOnce({ id: 'ord_sv_4', fulfillment_status: 'picking', fulfillment_outlet_id: null, total_amount: 5000, items_json: '[]', delivery_address_json: null })
        .mockResolvedValueOnce(null);
      const req = makeRequest('PATCH', '/fulfillment-queue/ord_sv_4/packed');
      const res = await posRouter.fetch(req, envWithQueue as any);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; data: { fulfillment_packed_at: string } };
      expect(typeof body.data.fulfillment_packed_at).toBe('string');
    });
  });

  // ─── Multi-tenancy isolation ──────────────────────────────────────────────────
  describe('Multi-tenancy isolation', () => {
    it('should isolate product data between tenants', async () => {
      const req1 = makeRequest('GET', '/cmrc_products', undefined, 'tenant_A');
      const req2 = makeRequest('GET', '/cmrc_products', undefined, 'tenant_B');
      const [res1, res2] = await Promise.all([
        posRouter.fetch(req1, mockEnv as any),
        posRouter.fetch(req2, mockEnv as any),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('should reject requests without tenant header', async () => {
      const req = new Request('http://localhost/cmrc_products', { method: 'GET' });
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

  // ─── T-COM-02: WhatsApp Digital Receipts ─────────────────────────────────────
  describe('T-COM-02: WhatsApp Digital Receipts', () => {
    const envWithTermii = { ...mockEnv, TERMII_API_KEY: 'test_termii_key' };

    describe('POST /receipts/send-whatsapp', () => {
      it('returns 400 when order_id is missing', async () => {
        const req = makeRequest('POST', '/receipts/send-whatsapp', { customer_phone: '08012345678' });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/order_id/i);
      });

      it('returns 400 when customer_phone is missing', async () => {
        const req = makeRequest('POST', '/receipts/send-whatsapp', { order_id: 'ord_test_1' });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(400);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/customer_phone/i);
      });

      it('returns 422 for an invalid phone number format', async () => {
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_test_1',
          customer_phone: '123',
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(422);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/phone/i);
      });

      it('returns 503 when TERMII_API_KEY is not configured', async () => {
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_test_1',
          customer_phone: '08012345678',
        });
        const res = await posRouter.fetch(req, mockEnv as any);
        expect(res.status).toBe(503);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/TERMII/i);
      });

      it('returns 404 when order is not found for tenant', async () => {
        mockDb.first.mockResolvedValueOnce(null);
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_does_not_exist',
          customer_phone: '08012345678',
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(404);
        const body = await res.json() as { success: boolean; error: string };
        expect(body.success).toBe(false);
        expect(body.error).toMatch(/not found/i);
      });

      it('sends message and returns 200 with messageId on success', async () => {
        mockDb.first.mockResolvedValueOnce({
          id: 'ord_wa_1',
          total_amount: 250000,
          payment_method: 'cash',
          order_status: 'fulfilled',
          created_at: Date.now() - 60000,
          items_json: JSON.stringify([{ name: 'Jollof Rice', quantity: 2, price: 125000 }]),
        });
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_wa_1',
          customer_phone: '08012345678',
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; data: { messageId: string; phone: string; order_id: string; channel: string } };
        expect(body.success).toBe(true);
        expect(body.data.phone).toBe('+2348012345678');
        expect(body.data.order_id).toBe('ord_wa_1');
        expect(typeof body.data.messageId).toBe('string');
      });

      it('normalises +234 international prefix correctly', async () => {
        mockDb.first.mockResolvedValueOnce({
          id: 'ord_wa_2',
          total_amount: 100000,
          payment_method: 'transfer',
          order_status: 'fulfilled',
          created_at: Date.now(),
          items_json: '[]',
        });
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_wa_2',
          customer_phone: '+2347055556666',
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; data: { phone: string } };
        expect(body.data.phone).toBe('+2347055556666');
      });

      it('normalises 234XXXXXXXXXX (no plus) prefix correctly', async () => {
        mockDb.first.mockResolvedValueOnce({
          id: 'ord_wa_3',
          total_amount: 50000,
          payment_method: 'card',
          order_status: 'fulfilled',
          created_at: Date.now(),
          items_json: '[]',
        });
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_wa_3',
          customer_phone: '2348098765432',
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; data: { phone: string } };
        expect(body.data.phone).toBe('+2348098765432');
      });

      it('enforces tenant isolation — DB query binds tenant_id alongside order_id', async () => {
        mockDb.first.mockResolvedValueOnce(null);
        const req = makeRequest('POST', '/receipts/send-whatsapp', {
          order_id: 'ord_other_tenant',
          customer_phone: '08099990000',
        }, 'tnt_isolated');
        await posRouter.fetch(req, envWithTermii as any);
        const bindCalls = (mockDb.bind.mock.calls as Array<unknown[]>);
        const ordBindCall = bindCalls.find(args => args.includes('ord_other_tenant'));
        expect(ordBindCall).toBeDefined();
        const ordArgs = ordBindCall as string[];
        expect(ordArgs).toContain('tnt_isolated');
      });
    });

    describe('POST /sync with receipt_notification entity', () => {
      it('applies a receipt_notification mutation via Termii on sync', async () => {
        mockDb.first.mockResolvedValueOnce({
          id: 'ord_sync_wa_1',
          total_amount: 75000,
          payment_method: 'cash',
          order_status: 'fulfilled',
          created_at: Date.now() - 120000,
          items_json: JSON.stringify([{ name: 'Puff Puff', quantity: 3, price: 25000 }]),
        });
        const req = makeRequest('POST', '/sync', {
          mutations: [{
            entity_type: 'receipt_notification',
            entity_id: 'rn_ord_sync_wa_1_1234567890',
            action: 'CREATE',
            payload: { order_id: 'ord_sync_wa_1', customer_phone: '08055556666' },
            version: 1,
          }],
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; data: { applied: string[]; skipped: string[]; failed: string[] } };
        expect(body.success).toBe(true);
        expect(body.data.applied).toContain('rn_ord_sync_wa_1_1234567890');
        expect(body.data.skipped).toHaveLength(0);
        expect(body.data.failed).toHaveLength(0);
      });

      it('skips receipt_notification when payload has no phone', async () => {
        const req = makeRequest('POST', '/sync', {
          mutations: [{
            entity_type: 'receipt_notification',
            entity_id: 'rn_no_phone',
            action: 'CREATE',
            payload: { order_id: 'ord_abc', customer_phone: '' },
            version: 1,
          }],
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        const body = await res.json() as { success: boolean; data: { skipped: string[] } };
        expect(body.data.skipped).toContain('rn_no_phone');
      });

      it('skips receipt_notification when TERMII_API_KEY is absent', async () => {
        const req = makeRequest('POST', '/sync', {
          mutations: [{
            entity_type: 'receipt_notification',
            entity_id: 'rn_no_key',
            action: 'CREATE',
            payload: { order_id: 'ord_abc', customer_phone: '08012345678' },
            version: 1,
          }],
        });
        const res = await posRouter.fetch(req, mockEnv as any);
        const body = await res.json() as { success: boolean; data: { skipped: string[] } };
        expect(body.data.skipped).toContain('rn_no_key');
      });

      it('skips receipt_notification when order not found for tenant', async () => {
        mockDb.first.mockResolvedValueOnce(null);
        const req = makeRequest('POST', '/sync', {
          mutations: [{
            entity_type: 'receipt_notification',
            entity_id: 'rn_missing_order',
            action: 'CREATE',
            payload: { order_id: 'ord_ghost', customer_phone: '08012345678' },
            version: 1,
          }],
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        const body = await res.json() as { success: boolean; data: { skipped: string[] } };
        expect(body.data.skipped).toContain('rn_missing_order');
      });

      it('handles mixed mutations — order CREATE + receipt_notification in one batch', async () => {
        mockDb.first
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({
            id: 'ord_sync_mix_1',
            total_amount: 30000,
            payment_method: 'cash',
            order_status: 'fulfilled',
            created_at: Date.now(),
            items_json: '[]',
          });
        mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
        const req = makeRequest('POST', '/sync', {
          mutations: [
            {
              entity_type: 'order',
              entity_id: 'offline_order_mix',
              action: 'CREATE',
              payload: { items: [], subtotal: 30000, total_amount: 30000, payment_method: 'cash' },
              version: 1,
            },
            {
              entity_type: 'receipt_notification',
              entity_id: 'rn_mix_1',
              action: 'CREATE',
              payload: { order_id: 'ord_sync_mix_1', customer_phone: '09011112222' },
              version: 1,
            },
          ],
        });
        const res = await posRouter.fetch(req, envWithTermii as any);
        expect(res.status).toBe(200);
        const body = await res.json() as { success: boolean; data: { applied: string[] } };
        expect(body.data.applied).toContain('rn_mix_1');
      });
    });
  });
});
