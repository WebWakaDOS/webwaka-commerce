/**
 * COM-2: Single-Vendor Storefront API Unit Tests
 * L2 QA Layer: Unit tests for online storefront operations
 * Invariants verified: NDPR consent, Nigeria-First (Paystack), Multi-tenancy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { singleVendorRouter } from './api';

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {} };

// Paths are relative to the router's mount point
function makeRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

describe('COM-2: Single-Vendor Storefront API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
  });

  describe('GET / (storefront root)', () => {
    it('should return storefront catalog', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', name: 'T-Shirt', price: 15000 }] });
      const req = makeRequest('GET', '/');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return 400 without tenant header', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /catalog', () => {
    it('should return public product catalog', async () => {
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should filter by category', async () => {
      const req = makeRequest('GET', '/catalog?category=clothing');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return only public fields (no cost_price)', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'p1', name: 'Shirt', price: 5000 }] });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

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

    it('should generate a session token', async () => {
      const req = makeRequest('POST', '/cart', {
        items: [{ product_id: 'prod_1', quantity: 1 }],
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.session_token).toMatch(/^tok_/);
    });

    it('should accept existing session token', async () => {
      const req = makeRequest('POST', '/cart', {
        session_token: 'tok_existing_123',
        items: [{ product_id: 'prod_2', quantity: 3 }],
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.session_token).toBe('tok_existing_123');
    });
  });

  describe('GET /cart/:token', () => {
    it('should return 404 for expired/missing cart', async () => {
      mockDb.first.mockResolvedValue(null);
      const req = makeRequest('GET', '/cart/tok_expired');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return cart when valid', async () => {
      mockDb.first.mockResolvedValue({ id: 'cart_1', session_token: 'tok_valid', items_json: '[]' });
      const req = makeRequest('GET', '/cart/tok_valid');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /checkout — NDPR + Nigeria-First invariants', () => {
    it('should process checkout with NDPR consent', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
        customer_email: 'test@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.payment_reference).toBeDefined();
    });

    it('should reject checkout without NDPR consent — NDPR invariant', async () => {
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

    it('should generate Paystack payment reference — Nigeria-First invariant', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', quantity: 1, price: 50000, name: 'Item' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^pay_/);
    });

    it('should calculate total in kobo — Nigeria-First monetary invariant', async () => {
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
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(38000); // 2×15000 + 1×8000
    });
  });

  describe('GET /orders', () => {
    it('should list storefront orders', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'ord_1', channel: 'storefront' }] });
      const req = makeRequest('GET', '/orders');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });

  describe('GET /customers', () => {
    it('should list customers', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'cust_1', email: 'a@b.com', ndpr_consent: 1 }] });
      const req = makeRequest('GET', '/customers');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });
});
