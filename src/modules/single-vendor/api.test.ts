/**
 * COM-2: Single-Vendor Storefront API Unit Tests — SV Phase 1
 * L2 QA Layer: Unit tests for online storefront operations.
 *
 * SV Phase 1 critical tests:
 *   SEC-1: Price tamper rejection (409)
 *   SEC-3: Out-of-stock rejection (409)
 *   SEC-4: Negative quantity rejection (400)
 *   INV-NDPR: NDPR consent gate (400)
 *   INV-NF: Nigeria-First payment reference (PAY_SV_ prefix)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { singleVendorRouter } from './api';

// ── Mock D1 ────────────────────────────────────────────────────────────────────
let mockFirstImpl: () => Promise<unknown> = () => Promise.resolve(null);

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockImplementation(() => mockFirstImpl()),
  run: vi.fn().mockResolvedValue({ success: true }),
  batch: vi.fn().mockResolvedValue([
    { meta: { changes: 1 } },  // INSERT orders
    { meta: { changes: 1 } },  // UPDATE products stock
    { meta: { changes: 1 } },  // INSERT customers
  ]),
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

/** Helper: make mockDb.first return a valid product for each call. */
function mockProductInDb(overrides: Partial<{ id: string; name: string; price: number; quantity: number }> = {}) {
  const prod = { id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10, ...overrides };
  mockFirstImpl = () => Promise.resolve(prod);
}

describe('COM-2: Single-Vendor Storefront API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockFirstImpl = () => Promise.resolve(null);
    mockDb.first.mockImplementation(() => mockFirstImpl());
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.batch.mockResolvedValue([
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ]);
  });

  // ── Tenant middleware ─────────────────────────────────────────────────────
  describe('Tenant middleware', () => {
    it('should return 400 without x-tenant-id header on any route', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/tenant/i);
    });

    it('should accept x-tenant-id header in any case', async () => {
      const req = new Request('http://localhost/', {
        method: 'GET',
        headers: { 'X-Tenant-ID': 'tnt_case_test' },
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ── GET / (storefront root) ───────────────────────────────────────────────
  describe('GET / (storefront root)', () => {
    it('should return storefront catalog', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', name: 'T-Shirt', price: 15000 }] });
      const req = makeRequest('GET', '/');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return empty data on DB error (graceful fallback)', async () => {
      mockDb.prepare.mockImplementationOnce(() => { throw new Error('DB down'); });
      const req = makeRequest('GET', '/');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  // ── GET /catalog ──────────────────────────────────────────────────────────
  describe('GET /catalog', () => {
    it('should return public product catalog wrapped in { products }', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'p1', name: 'Shirt', price: 5000, quantity: 20 }] });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('products');
      expect(Array.isArray(data.data.products)).toBe(true);
    });

    it('should filter by category when provided', async () => {
      const req = makeRequest('GET', '/catalog?category=clothing');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return empty products array on DB error (graceful)', async () => {
      mockDb.prepare.mockImplementationOnce(() => { throw new Error('DB error'); });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.products).toEqual([]);
    });

    it('should not expose cost_price in catalog response', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'p1', name: 'Shirt', price: 5000 }] });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.products[0]).not.toHaveProperty('cost_price');
    });
  });

  // ── POST /cart ────────────────────────────────────────────────────────────
  describe('POST /cart', () => {
    it('should create a cart session', async () => {
      const req = makeRequest('POST', '/cart', {
        items: [{ product_id: 'prod_1', quantity: 2 }],
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.session_token).toBeDefined();
    });

    it('should generate a tok_ prefixed session token', async () => {
      const req = makeRequest('POST', '/cart', {
        items: [{ product_id: 'prod_1', quantity: 1 }],
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.session_token).toMatch(/^tok_/);
    });

    it('should preserve an existing session token', async () => {
      const req = makeRequest('POST', '/cart', {
        session_token: 'tok_existing_123',
        items: [{ product_id: 'prod_2', quantity: 3 }],
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.session_token).toBe('tok_existing_123');
    });

    it('should store items in the cart response', async () => {
      const items = [{ product_id: 'prod_1', quantity: 2 }, { product_id: 'prod_2', quantity: 1 }];
      const req = makeRequest('POST', '/cart', { items });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.items).toHaveLength(2);
    });
  });

  // ── GET /cart/:token ──────────────────────────────────────────────────────
  describe('GET /cart/:token', () => {
    it('should return 404 for expired or missing cart', async () => {
      mockFirstImpl = () => Promise.resolve(null);
      const req = makeRequest('GET', '/cart/tok_expired');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return cart data when valid token provided', async () => {
      mockFirstImpl = () => Promise.resolve({ id: 'cart_1', session_token: 'tok_valid', items_json: '[]' });
      const req = makeRequest('GET', '/cart/tok_valid');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  // ── POST /checkout ────────────────────────────────────────────────────────
  describe('POST /checkout — NDPR invariant', () => {
    it('should reject checkout without NDPR consent — INV-NDPR', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'test@example.com',
        payment_method: 'paystack',
        ndpr_consent: false,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('NDPR');
    });

    it('should reject empty cart — INV-CART', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [],
        customer_email: 'test@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/empty/i);
    });

    it('should reject missing customer contact — INV-CONTACT', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/email|phone/i);
    });
  });

  describe('POST /checkout — SEC-4 negative/zero quantity', () => {
    it('should reject zero quantity items', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 0, price: 20000, name: 'T-Shirt' }],
        customer_email: 'test@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/quantity|invalid/i);
    });

    it('should reject negative quantity items', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: -5, price: 20000, name: 'T-Shirt' }],
        customer_email: 'test@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /checkout — SEC-1 price tamper rejection', () => {
    it('should return 409 when client sends lower price than D1 — SEC-1', async () => {
      mockProductInDb({ price: 20000, quantity: 10 }); // D1 price = 20000 kobo
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'T-Shirt' }], // tampered!
        customer_email: 'hacker@evil.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/price changed|refresh/i);
    });

    it('should return 409 when client sends higher price than D1 — SEC-1', async () => {
      mockProductInDb({ price: 20000, quantity: 10 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 99999, name: 'T-Shirt' }],
        customer_email: 'buyer@test.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
    });

    it('should succeed when client price matches D1 price exactly — SEC-1', async () => {
      mockProductInDb({ price: 20000, quantity: 10 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'honest@buyer.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });
  });

  describe('POST /checkout — SEC-3 stock validation', () => {
    it('should return 409 when requested quantity exceeds stock — SEC-3', async () => {
      mockProductInDb({ price: 20000, quantity: 2 }); // only 2 in stock
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 5, price: 20000, name: 'T-Shirt' }], // wants 5
        customer_email: 'buyer@test.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/stock|available/i);
    });

    it('should return 404 when product does not exist in D1', async () => {
      mockFirstImpl = () => Promise.resolve(null); // no product found
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'ghost_prod', quantity: 1, price: 20000, name: 'Ghost Item' }],
        customer_email: 'buyer@test.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toMatch(/not found/i);
    });

    it('should succeed when quantity exactly equals available stock — SEC-3', async () => {
      mockProductInDb({ price: 20000, quantity: 3 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 3, price: 20000, name: 'T-Shirt' }],
        customer_email: 'buyer@test.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });
  });

  describe('POST /checkout — Nigeria-First invariants', () => {
    it('should generate PAY_SV_ prefixed payment reference — INV-NF', async () => {
      mockProductInDb({ price: 50000, quantity: 5 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'Item' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^PAY_SV_/);
    });

    it('should compute total in kobo from server-verified D1 prices — INV-NGN', async () => {
      // D1 has price 15000, client sends 15000 — server uses D1 price
      let callCount = 0;
      mockFirstImpl = () => {
        callCount++;
        if (callCount === 1) return Promise.resolve({ id: 'prod_1', name: 'Shirt', price: 15000, quantity: 10 });
        return Promise.resolve({ id: 'prod_2', name: 'Cap', price: 8000, quantity: 10 });
      };
      const req = makeRequest('POST', '/checkout', {
        items: [
          { product_id: 'prod_1', quantity: 2, price: 15000, name: 'Shirt' },
          { product_id: 'prod_2', quantity: 1, price: 8000, name: 'Cap' },
        ],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(38000); // 2×15000 + 1×8000
    });

    it('should return order status confirmed — INV-ORDER-STATUS', async () => {
      mockProductInDb({ price: 20000, quantity: 5 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.order_status).toBe('confirmed');
    });

    it('should use phone number as contact if email not provided', async () => {
      mockProductInDb({ price: 20000, quantity: 5 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_phone: '08012345678',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should use D1 batch for atomic stock deduction — INV-ATOMIC', async () => {
      mockProductInDb({ price: 20000, quantity: 5 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      await singleVendorRouter.fetch(req, mockEnv as any);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('should return 409 on stock race condition (batch changes = 0)', async () => {
      mockProductInDb({ price: 20000, quantity: 5 });
      // Simulate race: stock deduction returns 0 changes
      mockDb.batch.mockResolvedValueOnce([
        { meta: { changes: 1 } },  // INSERT orders succeeded
        { meta: { changes: 0 } },  // UPDATE stock — race condition!
        { meta: { changes: 1 } },  // INSERT customers
      ]);
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/race|try again/i);
    });

    it('should handle multi-tenant isolation — INV-MT', async () => {
      mockProductInDb({ price: 20000, quantity: 5 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      }, 'tnt_other_tenant');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });
  });

  // ── GET /orders ───────────────────────────────────────────────────────────
  describe('GET /orders', () => {
    it('should list storefront orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'storefront' }] });
      const req = makeRequest('GET', '/orders');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return orders array', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1' }, { id: 'ord_2' }] });
      const req = makeRequest('GET', '/orders');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2);
    });
  });

  // ── GET /customers ────────────────────────────────────────────────────────
  describe('GET /customers', () => {
    it('should list customers with NDPR consent', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'cust_1', email: 'a@b.com', ndpr_consent: 1 }] });
      const req = makeRequest('GET', '/customers');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return empty list when no customers exist', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/customers');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
    });
  });
});
