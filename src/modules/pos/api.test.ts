/**
 * COM-1: POS API Unit Tests
 * L2 QA Layer: Unit tests for Point of Sale operations
 * Invariants verified: Multi-tenancy, Nigeria-First (kobo), Offline-First (sync), Stock correctness
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posRouter } from './api';

// ─── Mock D1 database ──────────────────────────────────────────────────────────
// batch() is the key addition: used for stock validation + atomic deduction
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

// Default batch response: sufficient stock for one item, deduction succeeds
const makeSufficientStockBatch = (qty = 100) => [
  { results: [{ id: 'prod_1', quantity: qty, name: 'Test Product' }], meta: { changes: 0 } },
];
const makeSuccessfulDeductBatch = (itemCount = 1) => [
  ...Array(itemCount).fill({ results: [], meta: { changes: 1 } }),
  { results: [], meta: { changes: 1 } }, // INSERT order
];

describe('COM-1: POS API', () => {
  beforeEach(() => {
    // resetAllMocks clears implementations AND mockResolvedValueOnce queues
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
    // Default batch: stock check returns sufficient qty, deductions succeed
    mockDb.batch
      .mockResolvedValueOnce(makeSufficientStockBatch(100))  // stock check
      .mockResolvedValueOnce(makeSuccessfulDeductBatch(1));   // deduct + insert
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
      const data = await res.json() as any;
      expect(data.success).toBe(true);
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

  // ─── POST /checkout ───────────────────────────────────────────────────────────
  describe('POST /checkout', () => {
    it('should process a POS sale successfully', async () => {
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

    // ── NEW: Stock validation tests ───────────────────────────────────────────
    it('should return 409 when stock is insufficient — oversell prevention', async () => {
      // Stock check: product has quantity 1, but 5 are requested
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
      expect(data.success).toBe(false);
      expect(data.error).toContain('Insufficient stock');
      expect(data.insufficient_items).toBeDefined();
      expect(data.insufficient_items[0].product_id).toBe('prod_1');
      expect(data.insufficient_items[0].available).toBe(1);
      expect(data.insufficient_items[0].requested).toBe(5);
    });

    it('should return 409 when stock is exactly zero — oversell prevention', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [{ id: 'prod_1', quantity: 0, name: 'Out of Stock Item' }], meta: { changes: 0 } },
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 5000, name: 'Out of Stock Item' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
    });

    it('should return 404 when product does not exist at checkout', async () => {
      mockDb.batch.mockReset();
      mockDb.batch.mockResolvedValueOnce([
        { results: [], meta: { changes: 0 } }, // empty results = product not found
      ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_nonexistent', quantity: 1, price: 5000, name: 'Ghost Product' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should call D1 batch to deduct inventory on successful checkout', async () => {
      // Verify batch() is called twice: once for stock check, once for deduct+insert
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

      // batch() called only once (stock check), not a second time (no deduction)
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('should report STOCK_RACE when concurrent checkout wins the race', async () => {
      // Stock check passes (qty=10), but UPDATE affects 0 rows (another sale won)
      mockDb.batch.mockReset();
      mockDb.batch
        .mockResolvedValueOnce([
          { results: [{ id: 'prod_1', quantity: 10, name: 'Last Unit' }], meta: { changes: 0 } },
        ])
        .mockResolvedValueOnce([
          { results: [], meta: { changes: 0 } }, // UPDATE matched 0 rows — race lost
          { results: [], meta: { changes: 1 } }, // INSERT order (never reached in logic)
        ]);

      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 10, price: 5000, name: 'Last Unit' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.code).toBe('STOCK_RACE');
      expect(data.error).toContain('retry');
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

    it('should return order id in response', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'Item' }],
        payment_method: 'cash',
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.id).toMatch(/^ord_pos_/);
    });
  });

  // ─── GET /orders ──────────────────────────────────────────────────────────────
  describe('GET /orders', () => {
    it('should list POS orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'pos' }] });
      const req = makeRequest('GET', '/orders');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
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
      mockDb.first.mockResolvedValue(null); // not already synced
      const req = makeRequest('POST', '/sync', {
        mutations: [{
          entity_type: 'order',
          entity_id: 'ord_offline_1',
          action: 'CREATE',
          payload: { items: [], subtotal: 50000, total_amount: 50000, payment_method: 'cash' },
          version: 1,
        }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.applied).toContain('ord_offline_1');
    });

    it('should return synced_at timestamp', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('POST', '/sync', {
        mutations: [{
          entity_type: 'order', entity_id: 'ord_offline_2', action: 'CREATE',
          payload: { items: [], subtotal: 0, total_amount: 0, payment_method: 'cash' }, version: 1,
        }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.synced_at).toBeGreaterThan(0);
    });

    it('should skip already-synced mutations — idempotency invariant', async () => {
      // first() returns an existing order, so this entity_id is already applied
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
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('today_orders');
      expect(data.data).toHaveProperty('today_revenue_kobo');
      expect(data.data).toHaveProperty('product_count');
      expect(data.data).toHaveProperty('low_stock_count');
    });

    it('should return zero values when no sales today', async () => {
      mockDb.first
        .mockResolvedValueOnce({ order_count: 0, total_revenue: 0 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.today_orders).toBe(0);
      expect(data.data.today_revenue_kobo).toBe(0);
    });

    it('should return 503 when DB is unavailable — not silent zeros', async () => {
      mockDb.first.mockRejectedValue(new Error('D1 connection timeout'));
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(503);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
    });
  });

  // ─── Multi-tenancy isolation — Build Once Use Infinitely ─────────────────────
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
      // bind() receives tenantId scoping each stock check
      expect(mockDb.bind).toHaveBeenCalledWith('prod_1', 'tnt_isolate');
    });
  });
});
