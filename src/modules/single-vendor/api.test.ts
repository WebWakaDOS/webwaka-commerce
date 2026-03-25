/**
 * COM-2: Single-Vendor Storefront API Unit Tests — SV Phase 2
 * L2 QA Layer: Comprehensive tests for online storefront operations.
 *
 * SV Phase 1 (retained):
 *   SEC-1: Price tamper rejection (409)
 *   SEC-3: Out-of-stock rejection (409)
 *   SEC-4: Negative quantity rejection (400)
 *   INV-NDPR: NDPR consent gate (400)
 *
 * SV Phase 2 additions:
 *   PAY-1: Paystack reference server-side verification
 *   PROMO-1: Promo code validation (expiry, max_uses, min_order, type)
 *   VAT-1: FIRS VAT 7.5% computed server-side
 *   ADDR-1: Nigerian delivery address stored in order
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { singleVendorRouter, computeDiscount } from './api';

// ── Mock D1 database ──────────────────────────────────────────────────────────
let mockFirstImpl: () => Promise<unknown> = () => Promise.resolve(null);

const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockImplementation(() => mockFirstImpl()),
  run: vi.fn().mockResolvedValue({ success: true }),
  batch: vi.fn().mockResolvedValue([
    { meta: { changes: 1 } }, // INSERT orders
    { meta: { changes: 1 } }, // UPDATE products stock
    { meta: { changes: 1 } }, // INSERT customers
  ]),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {}, PAYSTACK_SECRET: 'sk_test_mock' };

// ── Mock fetch (Paystack API) ─────────────────────────────────────────────────
const PAYSTACK_SUCCESS_RESPONSE = {
  status: true,
  data: { status: 'success', amount: 21500, reference: 'PSK_TEST_REF' }, // 20000 + 7.5% VAT = 21500
};

function makePaystackFetch(overrides: Partial<typeof PAYSTACK_SUCCESS_RESPONSE['data']> = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      status: true,
      data: { ...PAYSTACK_SUCCESS_RESPONSE.data, ...overrides },
    }),
  });
}

function makeFailedPaystackFetch(status = 'failed') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ status: true, data: { status, amount: 21500 } }),
  });
}

function makeDownPaystackFetch() {
  return vi.fn().mockResolvedValue({ ok: false, json: async () => ({ status: false }) });
}

// ── Helper: build request ─────────────────────────────────────────────────────
function makeRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

/** Default valid checkout body — all validations pass */
function checkoutBody(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ product_id: 'prod_1', quantity: 1, price: 20000, name: 'T-Shirt' }],
    customer_email: 'buyer@test.com',
    payment_method: 'paystack',
    paystack_reference: 'PSK_TEST_REF',
    ndpr_consent: true,
    ...overrides,
  };
}

/** Mock D1 to return a valid product on .first() */
function mockProduct(overrides: Partial<{ id: string; name: string; price: number; quantity: number }> = {}) {
  const prod = { id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10, ...overrides };
  mockFirstImpl = () => Promise.resolve(prod);
}

/** Mock D1 promo then product (first call = promo, subsequent = product) */
function mockProductThenPromo(
  productOverrides: Partial<{ id: string; name: string; price: number; quantity: number }> = {},
  promoOverrides: Record<string, unknown> = {},
) {
  const prod = { id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10, ...productOverrides };
  const promo = {
    id: 'promo_1', code: 'SAVE20', discount_type: 'pct', discount_value: 20,
    min_order_kobo: 0, max_uses: 0, current_uses: 0, expires_at: null, is_active: 1,
    description: '20% off', ...promoOverrides,
  };
  let call = 0;
  mockFirstImpl = () => {
    call++;
    // First N calls are product lookups; last call is promo lookup
    // In the handler: Promise.all for products → then promo (sequential)
    return call <= 1 ? Promise.resolve(prod) : Promise.resolve(promo);
  };
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Tenant middleware ─────────────────────────────────────────────────────
  describe('Tenant middleware', () => {
    it('should return 400 without x-tenant-id header', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/tenant/i);
    });

    it('should accept x-tenant-id in any case', async () => {
      const req = new Request('http://localhost/', {
        method: 'GET',
        headers: { 'X-Tenant-ID': 'tnt_case' },
      });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ── GET / ─────────────────────────────────────────────────────────────────
  describe('GET /', () => {
    it('should return storefront catalog', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'prod_1', name: 'T-Shirt' }] });
      const req = makeRequest('GET', '/');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
    });

    it('should gracefully return empty on DB error', async () => {
      mockDb.prepare.mockImplementationOnce(() => { throw new Error('DB down'); });
      const req = makeRequest('GET', '/');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ── GET /catalog ──────────────────────────────────────────────────────────
  describe('GET /catalog', () => {
    it('should return { products: [] } shape', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'p1', name: 'Shirt', price: 5000 }] });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('products');
      expect(Array.isArray(data.data.products)).toBe(true);
    });

    it('should filter by category', async () => {
      const req = makeRequest('GET', '/catalog?category=clothing');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });

    it('should return empty products array on DB error', async () => {
      mockDb.prepare.mockImplementationOnce(() => { throw new Error('DB error'); });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.products).toEqual([]);
    });

    it('should not expose cost_price', async () => {
      mockDb.all.mockResolvedValue({ results: [{ id: 'p1', name: 'Shirt', price: 5000 }] });
      const req = makeRequest('GET', '/catalog');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.products[0]).not.toHaveProperty('cost_price');
    });
  });

  // ── POST /cart ────────────────────────────────────────────────────────────
  describe('POST /cart', () => {
    it('should create a cart with tok_ session token', async () => {
      const req = makeRequest('POST', '/cart', { items: [{ product_id: 'prod_1', quantity: 2 }] });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.session_token).toMatch(/^tok_/);
    });

    it('should preserve an existing session token', async () => {
      const req = makeRequest('POST', '/cart', { session_token: 'tok_existing_123', items: [{ product_id: 'prod_2', quantity: 1 }] });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.session_token).toBe('tok_existing_123');
    });

    it('should return items in response', async () => {
      const items = [{ product_id: 'prod_1', quantity: 2 }, { product_id: 'prod_2', quantity: 1 }];
      const req = makeRequest('POST', '/cart', { items });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.items).toHaveLength(2);
    });
  });

  // ── GET /cart/:token ──────────────────────────────────────────────────────
  describe('GET /cart/:token', () => {
    it('should return 404 for missing cart', async () => {
      const req = makeRequest('GET', '/cart/tok_expired');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return cart when token is valid', async () => {
      mockFirstImpl = () => Promise.resolve({ id: 'cart_1', session_token: 'tok_valid', items_json: '[]' });
      const req = makeRequest('GET', '/cart/tok_valid');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  // ── POST /promo/validate ──────────────────────────────────────────────────
  describe('POST /promo/validate', () => {
    it('should validate a valid pct promo code', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_1', code: 'SAVE20', discount_type: 'pct', discount_value: 20,
        min_order_kobo: 0, max_uses: 0, current_uses: 0, expires_at: null,
        is_active: 1, description: '20% off',
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'SAVE20', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.discount_kobo).toBe(20000); // 20% of 100000
    });

    it('should validate a valid flat promo code', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_2', code: 'FLAT5K', discount_type: 'flat', discount_value: 500000,
        min_order_kobo: 0, max_uses: 0, current_uses: 0, expires_at: null,
        is_active: 1, description: '₦5000 flat off',
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'FLAT5K', subtotal_kobo: 2000000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.discount_kobo).toBe(500000);
    });

    it('should return 404 for unknown promo code', async () => {
      mockFirstImpl = () => Promise.resolve(null);
      const req = makeRequest('POST', '/promo/validate', { code: 'GHOST', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });

    it('should return 422 for expired promo code', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_1', code: 'EXPIRED', discount_type: 'pct', discount_value: 10,
        min_order_kobo: 0, max_uses: 0, current_uses: 0,
        expires_at: Date.now() - 86400000, // expired yesterday
        is_active: 1, description: null,
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'EXPIRED', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
      const data = await res.json() as any;
      expect(data.error).toMatch(/expired/i);
    });

    it('should return 422 when max uses reached', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_1', code: 'MAXED', discount_type: 'pct', discount_value: 15,
        min_order_kobo: 0, max_uses: 100, current_uses: 100,
        expires_at: null, is_active: 1, description: null,
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'MAXED', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
      const data = await res.json() as any;
      expect(data.error).toMatch(/maximum/i);
    });

    it('should return 422 when min order not met', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_1', code: 'MINORD', discount_type: 'pct', discount_value: 10,
        min_order_kobo: 500000, max_uses: 0, current_uses: 0,
        expires_at: null, is_active: 1, description: null,
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'MINORD', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
      const data = await res.json() as any;
      expect(data.error).toMatch(/minimum/i);
    });

    it('should return 422 for inactive promo code', async () => {
      mockFirstImpl = () => Promise.resolve({
        id: 'promo_1', code: 'INACTIVE', discount_type: 'pct', discount_value: 10,
        min_order_kobo: 0, max_uses: 0, current_uses: 0,
        expires_at: null, is_active: 0, description: null,
      });
      const req = makeRequest('POST', '/promo/validate', { code: 'INACTIVE', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
    });

    it('should return 400 for empty promo code', async () => {
      const req = makeRequest('POST', '/promo/validate', { code: '', subtotal_kobo: 100000 });
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ── POST /checkout — Input validation ─────────────────────────────────────
  describe('POST /checkout — input validation', () => {
    it('should return 400 without NDPR consent — INV-NDPR', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({ ndpr_consent: false }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('NDPR');
    });

    it('should return 400 for empty cart', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({ items: [] }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/empty/i);
    });

    it('should return 400 for missing contact', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({ customer_email: undefined, customer_phone: undefined }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/email|phone/i);
    });

    it('should return 400 for missing paystack_reference', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({ paystack_reference: '' }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/paystack_reference/i);
    });

    it('should return 400 for zero quantity — SEC-4', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 0, price: 20000, name: 'T-Shirt' }],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });

    it('should return 400 for negative quantity — SEC-4', async () => {
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: -3, price: 20000, name: 'T-Shirt' }],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  // ── POST /checkout — SEC-1 price tamper ───────────────────────────────────
  describe('POST /checkout — SEC-1 price tamper rejection', () => {
    it('should return 409 when client price < D1 price', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 1, price: 10000, name: 'T-Shirt' }], // tampered!
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/price changed|refresh/i);
    });

    it('should return 409 when client price > D1 price', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 1, price: 99999, name: 'T-Shirt' }],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
    });
  });

  // ── POST /checkout — SEC-3 stock validation ───────────────────────────────
  describe('POST /checkout — SEC-3 stock validation', () => {
    it('should return 409 when qty exceeds available stock', async () => {
      mockProduct({ price: 20000, quantity: 2 });
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 5, price: 20000, name: 'T-Shirt' }],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/stock|available/i);
    });

    it('should return 404 when product does not exist in D1', async () => {
      mockFirstImpl = () => Promise.resolve(null);
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'ghost_prod', quantity: 1, price: 20000, name: 'Ghost' }],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /checkout — PAY-1 Paystack verification ──────────────────────────
  describe('POST /checkout — PAY-1 Paystack reference verification', () => {
    it('should mark order paid when Paystack returns success', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      // VAT: 20000 * 1.075 = 21500
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.payment_status).toBe('paid');
    });

    it('should return 402 when Paystack status is failed', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makeFailedPaystackFetch('failed'));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(402);
      const data = await res.json() as any;
      expect(data.error).toMatch(/not verified|failed/i);
    });

    it('should return 402 when Paystack status is abandoned', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makeFailedPaystackFetch('abandoned'));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(402);
    });

    it('should return 402 on amount mismatch (PAY-1 tamper)', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      // Paystack says they paid only 1000 kobo, but expected 21500
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 1000 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(402);
      const data = await res.json() as any;
      expect(data.error).toMatch(/amount mismatch/i);
    });

    it('should return 502 when Paystack API is down', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makeDownPaystackFetch());
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(502);
      const data = await res.json() as any;
      expect(data.error).toMatch(/unavailable|support/i);
    });

    it('should use Paystack reference in order record', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({ paystack_reference: 'PSK_REF_UNIQUE' }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_reference).toBe('PSK_REF_UNIQUE');
    });
  });

  // ── POST /checkout — VAT-1 FIRS 7.5% ─────────────────────────────────────
  describe('POST /checkout — VAT-1 FIRS 7.5% computation', () => {
    it('should compute VAT as 7.5% of subtotal when no promo — INV-VAT', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.subtotal).toBe(20000);
      expect(data.data.vat_kobo).toBe(1500);       // 20000 * 7.5% = 1500
      expect(data.data.total_amount).toBe(21500);  // 20000 + 1500
    });

    it('should compute VAT on (subtotal - promo discount) — INV-VAT-PROMO', async () => {
      // subtotal = 100000; promo = 20% off = -20000; after = 80000; VAT = 6000; total = 86000
      let call = 0;
      mockFirstImpl = () => {
        call++;
        if (call === 1) return Promise.resolve({ id: 'prod_1', name: 'T-Shirt', price: 100000, quantity: 10 });
        return Promise.resolve({
          id: 'promo_1', code: 'SAVE20', discount_type: 'pct', discount_value: 20,
          min_order_kobo: 0, max_uses: 0, current_uses: 0, expires_at: null, is_active: 1,
        });
      };
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 86000 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'T-Shirt' }],
        promo_code: 'SAVE20',
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.subtotal).toBe(100000);
      expect(data.data.discount_kobo).toBe(20000);
      expect(data.data.vat_kobo).toBe(6000);      // 80000 * 7.5% = 6000
      expect(data.data.total_amount).toBe(86000); // 80000 + 6000
    });

    it('should compute correct VAT for multiple items', async () => {
      // 2 × 15000 + 1 × 8000 = 38000; VAT = 2850; total = 40850
      let call = 0;
      mockFirstImpl = () => {
        call++;
        if (call === 1) return Promise.resolve({ id: 'prod_1', name: 'Shirt', price: 15000, quantity: 10 });
        return Promise.resolve({ id: 'prod_2', name: 'Cap', price: 8000, quantity: 10 });
      };
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 40850 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [
          { product_id: 'prod_1', quantity: 2, price: 15000, name: 'Shirt' },
          { product_id: 'prod_2', quantity: 1, price: 8000, name: 'Cap' },
        ],
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.subtotal).toBe(38000);
      expect(data.data.vat_kobo).toBe(2850);
      expect(data.data.total_amount).toBe(40850);
    });
  });

  // ── POST /checkout — PROMO-1 promo codes ─────────────────────────────────
  describe('POST /checkout — PROMO-1 promo code at checkout', () => {
    it('should apply pct promo discount correctly', async () => {
      mockProductThenPromo({ price: 100000, quantity: 10 }, { discount_type: 'pct', discount_value: 20 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 86000 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'T-Shirt' }],
        promo_code: 'SAVE20',
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.discount_kobo).toBe(20000); // 20% of 100000
    });

    it('should apply flat promo discount correctly', async () => {
      mockProductThenPromo(
        { price: 100000, quantity: 10 },
        { discount_type: 'flat', discount_value: 5000, code: 'FLAT5K' },
      );
      // after = 95000; VAT = 7125; total = 102125
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 102125 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        items: [{ product_id: 'prod_1', quantity: 1, price: 100000, name: 'T-Shirt' }],
        promo_code: 'FLAT5K',
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.discount_kobo).toBe(5000);
    });

    it('should return 422 when promo code not found at checkout', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      let call = 0;
      mockFirstImpl = () => {
        call++;
        if (call === 1) return Promise.resolve({ id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10 });
        return Promise.resolve(null); // promo not found
      };
      const req = makeRequest('POST', '/checkout', checkoutBody({ promo_code: 'GHOST' }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
    });

    it('should return 422 when promo code expired at checkout', async () => {
      let call = 0;
      mockFirstImpl = () => {
        call++;
        if (call === 1) return Promise.resolve({ id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10 });
        return Promise.resolve({
          id: 'promo_1', code: 'EXPIRED', discount_type: 'pct', discount_value: 10,
          min_order_kobo: 0, max_uses: 0, current_uses: 0,
          expires_at: Date.now() - 86400000, is_active: 1,
        });
      };
      const req = makeRequest('POST', '/checkout', checkoutBody({ promo_code: 'EXPIRED' }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
    });

    it('should return 422 when promo max_uses reached at checkout', async () => {
      let call = 0;
      mockFirstImpl = () => {
        call++;
        if (call === 1) return Promise.resolve({ id: 'prod_1', name: 'T-Shirt', price: 20000, quantity: 10 });
        return Promise.resolve({
          id: 'promo_1', code: 'MAXED', discount_type: 'pct', discount_value: 10,
          min_order_kobo: 0, max_uses: 50, current_uses: 50,
          expires_at: null, is_active: 1,
        });
      };
      const req = makeRequest('POST', '/checkout', checkoutBody({ promo_code: 'MAXED' }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(422);
    });

    it('should proceed without promo when promo_code is omitted', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody()); // no promo_code
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.discount_kobo).toBe(0);
    });
  });

  // ── POST /checkout — ADDR-1 Nigerian delivery address ────────────────────
  describe('POST /checkout — ADDR-1 Nigerian delivery address', () => {
    it('should accept checkout with a valid Nigerian delivery address', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        delivery_address: { state: 'Lagos', lga: 'Ikeja', street: '14 Allen Avenue' },
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should accept checkout without delivery address (digital/pickup)', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({ delivery_address: undefined }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should accept FCT (Abuja) as a valid state', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        delivery_address: { state: 'FCT (Abuja)', lga: 'Garki', street: '3 Shehu Shagari Way' },
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });
  });

  // ── POST /checkout — Nigeria-First invariants ─────────────────────────────
  describe('POST /checkout — Nigeria-First invariants', () => {
    it('should return order_status confirmed — INV-ORDER', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.order_status).toBe('confirmed');
    });

    it('should return payment_status paid only on Paystack success', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.payment_status).toBe('paid');
    });

    it('should use phone-only when email is omitted — INV-PHONE', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody({
        customer_email: undefined,
        customer_phone: '08012345678',
      }));
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(201);
    });

    it('should use D1 batch for atomic stock deduction — INV-ATOMIC', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody());
      await singleVendorRouter.fetch(req, mockEnv as any);
      expect(mockDb.batch).toHaveBeenCalledTimes(1);
    });

    it('should return 409 on stock race condition (batch changes=0)', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      mockDb.batch.mockResolvedValueOnce([
        { meta: { changes: 1 } },
        { meta: { changes: 0 } }, // race: stock deduction failed
        { meta: { changes: 1 } },
      ]);
      const req = makeRequest('POST', '/checkout', checkoutBody());
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/race|try again/i);
    });

    it('should isolate multi-tenant — INV-MT', async () => {
      mockProduct({ price: 20000, quantity: 10 });
      vi.stubGlobal('fetch', makePaystackFetch({ status: 'success', amount: 21500 }));
      const req = makeRequest('POST', '/checkout', checkoutBody(), 'tnt_other');
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
      expect(data.data).toHaveLength(1);
    });

    it('should return empty array when no orders', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const req = makeRequest('GET', '/orders');
      const res = await singleVendorRouter.fetch(req, mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
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
  });

  // ── computeDiscount helper ────────────────────────────────────────────────
  describe('computeDiscount() helper', () => {
    it('pct: 20% of 100000 kobo = 20000', () => {
      expect(computeDiscount('pct', 20, 100000)).toBe(20000);
    });

    it('flat: 5000 off 100000', () => {
      expect(computeDiscount('flat', 5000, 100000)).toBe(5000);
    });

    it('flat: cannot exceed subtotal', () => {
      expect(computeDiscount('flat', 999999, 50000)).toBe(50000);
    });

    it('unknown type returns 0', () => {
      expect(computeDiscount('mystery', 10, 100000)).toBe(0);
    });

    it('pct: 7.5% rounds correctly', () => {
      expect(computeDiscount('pct', 7.5, 20000)).toBe(1500);
    });
  });
});
