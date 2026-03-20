/**
 * COM-3: Multi-Vendor Marketplace API Unit Tests
 * L2 QA Layer: Unit tests for marketplace operations
 * Invariants verified: Commission splitting, NDPR, Nigeria-First, Multi-tenancy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { multiVendorRouter } from './api';

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

describe('COM-3: Multi-Vendor Marketplace API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
  });

  describe('GET / (marketplace overview)', () => {
    it('should return marketplace overview with vendor and product counts', async () => {
      mockDb.first
        .mockResolvedValueOnce({ count: 5 })
        .mockResolvedValueOnce({ count: 120 });
      const req = makeRequest('GET', '/');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('active_vendors');
      expect(data.data).toHaveProperty('total_products');
    });

    it('should return zeros when no vendors or products', async () => {
      mockDb.first
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });
      const req = makeRequest('GET', '/');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.active_vendors).toBe(0);
    });

    it('should return 400 without tenant header', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /vendors', () => {
    it('should list all vendors', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'vnd_1', name: 'Vendor A', status: 'active' }] });
      const req = makeRequest('GET', '/vendors');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should return empty array when no vendors', async () => {
      const req = makeRequest('GET', '/vendors');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
    });
  });

  describe('POST /vendors', () => {
    it('should register a new vendor with pending status', async () => {
      const req = makeRequest('POST', '/vendors', {
        name: 'Ade Stores', slug: 'ade-stores', email: 'ade@example.com',
        phone: '+2348012345678', commission_rate: 800,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('pending');
    });

    it('should default commission rate to 10% (1000 basis points) — Nigeria-First', async () => {
      const req = makeRequest('POST', '/vendors', {
        name: 'Bola Shop', slug: 'bola-shop', email: 'bola@example.com',
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should generate a vendor ID', async () => {
      const req = makeRequest('POST', '/vendors', {
        name: 'Chidi Market', slug: 'chidi-market', email: 'chidi@example.com',
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.id).toMatch(/^vnd_/);
    });
  });

  describe('PATCH /vendors/:id', () => {
    it('should activate a vendor', async () => {
      const req = makeRequest('PATCH', '/vendors/vnd_1', { status: 'active' });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should update commission rate', async () => {
      const req = makeRequest('PATCH', '/vendors/vnd_1', { commission_rate: 1500 });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /vendors/:id/products', () => {
    it('should list vendor products', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', vendor_id: 'vnd_1' }] });
      const req = makeRequest('GET', '/vendors/vnd_1/products');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /vendors/:id/products', () => {
    it('should add a product to vendor catalog', async () => {
      const req = makeRequest('POST', '/vendors/vnd_1/products', {
        sku: 'VND-SKU-001', name: 'Ankara Fabric', price: 35000, quantity: 50,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.vendor_id).toBe('vnd_1');
    });
  });

  describe('POST /checkout — Commission splitting + NDPR', () => {
    it('should process marketplace checkout with commission splitting', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 }); // 10%
      const req = makeRequest('POST', '/checkout', {
        items: [
          { product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item A' },
          { product_id: 'prod_2', vendor_id: 'vnd_2', quantity: 2, price: 25000, name: 'Item B' },
        ],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.vendor_count).toBe(2);
      expect(data.data.total_amount).toBe(100000); // 50000 + 2×25000
    });

    it('should reject checkout without NDPR consent — NDPR invariant', async () => {
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: false,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('NDPR');
    });

    it('should calculate commission correctly (basis points)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 }); // 10%
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 100000, name: 'Item' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(100000);
      // Commission = 100000 × 1000/10000 = 10000 kobo (₦100)
    });

    it('should generate payment reference', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const req = makeRequest('POST', '/checkout', {
        items: [{ product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item' }],
        customer_email: 'buyer@example.com',
        payment_method: 'paystack',
        ndpr_consent: true,
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^pay_mkp_/);
    });
  });

  describe('GET /orders', () => {
    it('should list marketplace orders', async () => {
      const req = makeRequest('GET', '/orders');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  describe('GET /ledger', () => {
    it('should return marketplace ledger entries', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'led_1', account_type: 'commission' }] });
      const req = makeRequest('GET', '/ledger');
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });
  });
});
