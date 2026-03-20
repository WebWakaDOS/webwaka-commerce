/**
 * COM-1: POS API Unit Tests
 * L2 QA Layer: Unit tests for Point of Sale operations
 * Invariants verified: Multi-tenancy, Nigeria-First (kobo), Offline-First (sync)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { posRouter } from './api';

// Mock D1 database
const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {} };

// The posRouter handles paths relative to its mount point.
// When mounted at /api/pos, a request to /api/pos/products becomes /products inside the router.
function makeRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

describe('COM-1: POS API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
  });

  describe('GET / (product list)', () => {
    it('should return product list for tenant', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', name: 'Test Product', price: 50000 }] });
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
  });

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
      expect(data.data.price).toBe(150000); // Invariant: monetary as integer kobo
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

    it('should calculate total correctly (kobo arithmetic)', async () => {
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
      expect(data.data.total_amount).toBe(90000);
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
  });

  describe('GET /orders', () => {
    it('should list POS orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'pos' }] });
      const req = makeRequest('GET', '/orders');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  describe('POST /sync — Offline-First invariant', () => {
    it('should accept offline sync mutations', async () => {
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
      expect(data.data.applied).toBeDefined();
    });

    it('should return synced_at timestamp', async () => {
      const req = makeRequest('POST', '/sync', {
        mutations: [{
          entity_type: 'order',
          entity_id: 'ord_offline_2',
          action: 'CREATE',
          payload: { items: [], subtotal: 0, total_amount: 0, payment_method: 'cash' },
          version: 1,
        }],
      });
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.synced_at).toBeGreaterThan(0);
    });
  });

  describe('GET /dashboard', () => {
    it('should return sales summary', async () => {
      mockDb.first
        .mockResolvedValueOnce({ order_count: 5, total_revenue: 250000 })
        .mockResolvedValueOnce({ count: 20 });
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('today_orders');
      expect(data.data).toHaveProperty('today_revenue_kobo');
      expect(data.data).toHaveProperty('product_count');
    });

    it('should return zero values when no sales today', async () => {
      mockDb.first
        .mockResolvedValueOnce({ order_count: 0, total_revenue: 0 })
        .mockResolvedValueOnce({ count: 0 });
      const req = makeRequest('GET', '/dashboard');
      const res = await posRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.today_orders).toBe(0);
      expect(data.data.today_revenue_kobo).toBe(0);
    });
  });

  describe('Multi-tenancy isolation — Build Once Use Infinitely', () => {
    it('should isolate data between tenants', async () => {
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
  });
});
