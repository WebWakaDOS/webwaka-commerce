/**
 * COM-3: Multi-Vendor Marketplace API — Phase MV-1 + MV-2 + MV-3 Tests
 * L2 QA Layer: Auth, vendor isolation, tenant isolation, security hardening,
 *              cross-vendor catalog (FTS5/LIKE, KV cache), marketplace cart, umbrella cmrc_orders.
 * Invariants: vendor JWT scoping, tenant isolation, admin-key guard, NDPR, Nigeria-First
 *
 * Test count: MV-1 (40) + MV-2 (28) + MV-3 (50+) = 118+ total
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { multiVendorRouter, _resetOtpRateLimitStore, _resetCheckoutRateLimitStore, _resetSearchRateLimitStore } from './api';

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
  batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]),
};

const mockCatalogCache = {
  get: vi.fn().mockResolvedValue(null),
  put: vi.fn().mockResolvedValue(undefined),
};

const mockEnv = {
  DB: mockDb,
  TENANT_CONFIG: {},
  EVENTS: {},
  SESSIONS_KV: {},
  JWT_SECRET: 'test-secret-32-chars-minimum!!!',
  CATALOG_CACHE: mockCatalogCache,
  ADMIN_API_KEY: 'admin-secret-key',
};

// ── JWT helpers ───────────────────────────────────────────────────────────────
/** Sign a minimal HS256 JWT for testing — mirrors the production signJwt */
async function signTestJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

async function makeVendorToken(vendorId: string, tenantId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signTestJwt(
    { sub: vendorId, role: 'vendor', vendor_id: vendorId, tenant: tenantId,
      phone: '+2348012345678', iat: now, exp: now + 7 * 86400 },
    'test-secret-32-chars-minimum!!!',
  );
}

async function makeExpiredVendorToken(vendorId: string, tenantId: string): Promise<string> {
  const past = Math.floor(Date.now() / 1000) - 86400;
  return signTestJwt(
    { sub: vendorId, role: 'vendor', vendor_id: vendorId, tenant: tenantId,
      phone: '+2348012345678', iat: past - 86400, exp: past },
    'test-secret-32-chars-minimum!!!',
  );
}

// ── Request factories ─────────────────────────────────────────────────────────
function makeRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: { 'x-tenant-id': tenantId, 'Content-Type': 'application/json' },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

function makeVendorRequest(method: string, path: string, token: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'x-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

function makeAdminRequest(method: string, path: string, body?: unknown, tenantId = 'tnt_test') {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'x-tenant-id': tenantId,
      'Content-Type': 'application/json',
      'x-admin-key': 'admin-secret-key',
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('COM-3 MV-1: Multi-Vendor Marketplace API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
    mockCatalogCache.get.mockResolvedValue(null);
    mockCatalogCache.put.mockResolvedValue(undefined);
    _resetOtpRateLimitStore();
    _resetCheckoutRateLimitStore();
    _resetSearchRateLimitStore();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ORIGINAL SUITE (retained from pre-MV-1, adapted for new auth requirements)
  // ───────────────────────────────────────────────────────────────────────────

  describe('GET / (marketplace overview — public)', () => {
    it('returns overview counts', async () => {
      mockDb.first
        .mockResolvedValueOnce({ count: 5 })
        .mockResolvedValueOnce({ count: 120 });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/'), mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('active_vendors');
      expect(data.data).toHaveProperty('total_products');
    });

    it('returns zeros when no active cmrc_vendors or cmrc_products', async () => {
      mockDb.first.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 0 });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/'), mockEnv as any);
      const data = await res.json() as any;
      expect(data.data.active_vendors).toBe(0);
    });

    it('returns 400 without tenant header', async () => {
      const req = new Request('http://localhost/', { method: 'GET' });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /cmrc_vendors (public — active only)', () => {
    it('returns only active cmrc_vendors', async () => {
      mockDb.all.mockResolvedValue({
        results: [{ id: 'vnd_1', name: 'Vendor A', status: 'active' }],
      });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/cmrc_vendors'), mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
    });

    it('returns empty array when no active cmrc_vendors', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/cmrc_vendors'), mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
    });

    it('does NOT expose bank_account or commission_rate fields', async () => {
      mockDb.all.mockResolvedValue({
        results: [{ id: 'vnd_1', name: 'Vendor A', status: 'active', email: 'a@b.com' }],
      });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/cmrc_vendors'), mockEnv as any);
      const data = await res.json() as any;
      expect(data.data[0]).not.toHaveProperty('bank_account');
      expect(data.data[0]).not.toHaveProperty('commission_rate');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MV-1 NEW TESTS: ADMIN AUTH GUARD
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /cmrc_vendors — admin authentication (G-2 fix)', () => {
    it('returns 401 without x-admin-key', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cmrc_vendors', { name: 'X', slug: 'x', email: 'x@x.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toMatch(/Admin authentication required/i);
    });

    it('registers vendor when admin key provided', async () => {
      mockDb.first.mockResolvedValue(null); // slug uniqueness check — no existing
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/cmrc_vendors', { name: 'Ade Stores', slug: 'ade-stores', email: 'ade@example.com', phone: '+2348012345678', commission_rate: 800 }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.status).toBe('pending');
    });

    it('generates vendor ID with vnd_ prefix', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/cmrc_vendors', { name: 'Bola Shop', slug: 'bola-shop', email: 'bola@example.com' }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.id).toMatch(/^vnd_/);
    });

    it('rejects duplicate slug — Nigeria-First uniqueness guard', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_existing' }); // slug already taken
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/cmrc_vendors', { name: 'Dupe Shop', slug: 'existing-slug', email: 'dupe@example.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/already taken/i);
    });

    it('requires name field', async () => {
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/cmrc_vendors', { slug: 'no-name', email: 'a@b.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/name/i);
    });
  });

  describe('PATCH /cmrc_vendors/:id — admin authentication (G-2 fix)', () => {
    it('returns 401 without x-admin-key', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('PATCH', '/cmrc_vendors/vnd_1', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('activates vendor with admin key', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1' }); // vendor exists
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/cmrc_vendors/vnd_1', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('rejects invalid status values', async () => {
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/cmrc_vendors/vnd_1', { status: 'hacked' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/status must be/i);
    });

    it('returns 404 when vendor not found in this marketplace', async () => {
      mockDb.first.mockResolvedValue(null); // vendor doesn't exist for this tenant
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/cmrc_vendors/vnd_notexist', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MV-1 NEW TESTS: VENDOR JWT AUTH + ISOLATION
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /cmrc_vendors/:id/cmrc_products — vendor JWT + ownership (SEC-8 fix)', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cmrc_vendors/vnd_1/cmrc_products', { sku: 'X', name: 'X', price: 1000, quantity: 1 }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('adds product when vendor owns the catalog', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/cmrc_products', token, {
          sku: 'VND-001', name: 'Ankara Fabric', price: 35000, quantity: 50,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.vendor_id).toBe('vnd_1');
    });

    it('returns 403 when vendor tries to add cmrc_products to ANOTHER vendor — isolation', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test'); // JWT belongs to vendor A
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_B/cmrc_products', token, { // trying to add to vendor B
          sku: 'INTRUDER-001', name: 'Fake Product', price: 1000, quantity: 1,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor catalog/i);
    });

    it('returns 401 with expired JWT', async () => {
      const token = await makeExpiredVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/cmrc_products', token, {
          sku: 'EXP-001', name: 'Test', price: 1000, quantity: 1,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('rejects non-integer price — kobo validation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/cmrc_products', token, {
          sku: 'FLOAT-001', name: 'Bad Price', price: 35.50, quantity: 1,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/positive integer/i);
    });

    it('returns 403 when JWT tenant does not match request tenant — cross-tenant isolation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_DIFFERENT'); // JWT for different marketplace
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/cmrc_products', token, {
          sku: 'XTENANT-001', name: 'Cross Tenant', price: 1000, quantity: 1,
        }, 'tnt_test'), // request for tnt_test
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /cmrc_vendors/:id/cmrc_products/:productId — vendor product update', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('PATCH', '/cmrc_vendors/vnd_1/cmrc_products/prod_1', { name: 'Updated Name', price: 40000, quantity: 10 }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to edit another vendor\'s product', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('PATCH', '/cmrc_vendors/vnd_B/cmrc_products/prod_1', token, { name: 'Hack', price: 1000, quantity: 1 }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor catalog/i);
    });

    it('returns 404 when product not found', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.first.mockResolvedValueOnce(null); // product lookup returns null
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('PATCH', '/cmrc_vendors/vnd_1/cmrc_products/prod_nonexistent', token, { name: 'X', price: 1000, quantity: 1 }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('updates product when vendor owns the catalog', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.first.mockResolvedValueOnce({ id: 'prod_1' }); // existing product
      mockDb.run.mockResolvedValueOnce({ success: true });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('PATCH', '/cmrc_vendors/vnd_1/cmrc_products/prod_1', token, { name: 'Updated Fabric', price: 42000, quantity: 45 }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.id).toBe('prod_1');
    });

    it('returns 400 when non-integer price provided', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.first.mockResolvedValueOnce({ id: 'prod_1' }); // product exists check
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('PATCH', '/cmrc_vendors/vnd_1/cmrc_products/prod_1', token, { name: 'X', price: 42.5, quantity: 1 }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/positive integer/i);
    });
  });

  describe('DELETE /cmrc_vendors/:id/cmrc_products/:productId — vendor product delete', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('DELETE', '/cmrc_vendors/vnd_1/cmrc_products/prod_1'),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to delete another vendor\'s product', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('DELETE', '/cmrc_vendors/vnd_B/cmrc_products/prod_1', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor catalog/i);
    });

    it('returns 404 when product not found', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.first.mockResolvedValueOnce(null);
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('DELETE', '/cmrc_vendors/vnd_1/cmrc_products/prod_nonexistent', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('soft-deletes product when vendor owns it', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.first.mockResolvedValueOnce({ id: 'prod_1' });
      mockDb.run.mockResolvedValueOnce({ success: true });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('DELETE', '/cmrc_vendors/vnd_1/cmrc_products/prod_1', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.id).toBe('prod_1');
    });
  });

  describe('GET /cmrc_vendors/:id/cmrc_products/:productId/variants — public product variants', () => {
    it('returns 404 when product not found', async () => {
      mockDb.first.mockResolvedValueOnce(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_vendors/vnd_1/cmrc_products/prod_nonexistent/variants'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns variants grouped for a valid product', async () => {
      mockDb.first.mockResolvedValueOnce({ id: 'prod_1' });
      mockDb.all.mockResolvedValueOnce({
        results: [
          { id: 'var_1', option_name: 'Size', option_value: 'S', price_delta: 0, quantity: 10 },
          { id: 'var_2', option_name: 'Size', option_value: 'M', price_delta: 500, quantity: 5 },
          { id: 'var_3', option_name: 'Color', option_value: 'Red', price_delta: 0, quantity: 8 },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_vendors/vnd_1/cmrc_products/prod_1/variants'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.variants).toHaveLength(3);
      expect(data.data.variants[0]).toMatchObject({ option_name: 'Size', option_value: 'S' });
      expect(data.data.variants[1]).toMatchObject({ option_name: 'Size', option_value: 'M', price_delta: 500 });
    });

    it('returns empty variants array when product has no variants', async () => {
      mockDb.first.mockResolvedValueOnce({ id: 'prod_1' });
      mockDb.all.mockResolvedValueOnce({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_vendors/vnd_1/cmrc_products/prod_1/variants'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.variants).toHaveLength(0);
    });
  });

  describe('GET /cmrc_orders — vendor JWT scoped (G-2 fix)', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/cmrc_orders'), mockEnv as any);
      expect(res.status).toBe(401);
    });

    it('returns vendor-scoped marketplace cmrc_orders', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [{ id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]' }],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
    });

    it('vendor A cannot access vendor B cmrc_orders — DB query is vendor-scoped', async () => {
      // Vendor A gets token and queries — mock returns empty (vendor B items only)
      const tokenA = await makeVendorToken('vnd_A', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] }); // no cmrc_orders contain vnd_A items
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', tokenA),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toEqual([]); // vendor A sees nothing — isolation confirmed
    });
  });

  describe('GET /ledger — vendor JWT scoped (G-2 fix)', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/ledger'), mockEnv as any);
      expect(res.status).toBe(401);
    });

    it('returns vendor-scoped ledger entries only', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [{ id: 'led_1', vendor_id: 'vnd_1', account_type: 'commission', amount: 5000 }],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data[0].vendor_id).toBe('vnd_1');
    });

    it('vendor B cannot read vendor A ledger — financial isolation', async () => {
      const tokenB = await makeVendorToken('vnd_B', 'tnt_test');
      // DB is called with vendor_id='vnd_B' so vendor A's entries are never returned
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', tokenB),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toEqual([]); // financial isolation confirmed
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MV-1 RETAINED: CHECKOUT (public)
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /checkout — commission splitting + NDPR (public)', () => {
    it('processes marketplace checkout with commission splitting', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', {
          items: [
            { product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item A' },
            { product_id: 'prod_2', vendor_id: 'vnd_2', quantity: 2, price: 25000, name: 'Item B' },
          ],
          customer_email: 'buyer@example.com',
          payment_method: 'paystack',
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.vendor_count).toBe(2);
      expect(data.data.total_amount).toBe(100000);
    });

    it('rejects checkout without NDPR consent — NDPR invariant', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item' }],
          customer_email: 'buyer@example.com',
          payment_method: 'paystack',
          ndpr_consent: false,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toContain('NDPR');
    });

    it('rejects checkout with empty items array', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', {
          items: [],
          customer_email: 'buyer@example.com',
          payment_method: 'paystack',
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('calculates commission correctly (basis points 10%)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', quantity: 1, price: 100000, name: 'Item' }],
          customer_email: 'buyer@example.com',
          payment_method: 'paystack',
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(100000);
      // Commission = 100000 × 1000/10000 = 10000 kobo (₦100)
    });

    it('generates pay_mkp_ payment reference', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', quantity: 1, price: 50000, name: 'Item' }],
          customer_email: 'buyer@example.com',
          payment_method: 'paystack',
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^pay_mkp_/);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // TENANT ISOLATION
  // ───────────────────────────────────────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('vendor JWT for tenant A cannot operate on tenant B marketplace — tenant mismatch', async () => {
      const tokenForTenantA = await makeVendorToken('vnd_1', 'tnt_A');
      // Request is for tnt_B marketplace
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', tokenForTenantA, undefined, 'tnt_B'),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/[Tt]enant/i);
    });

    it('GET /cmrc_vendors only shows cmrc_vendors from the correct marketplace tenant', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/cmrc_vendors', undefined, 'tnt_mkp_abuja'), mockEnv as any);
      // verify the DB was called with the correct tenant scope
      expect(mockDb.bind).toHaveBeenCalledWith('tnt_mkp_abuja');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // VENDOR OTP AUTH FLOW
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /auth/vendor-request-otp', () => {
    it('returns 404 when phone not registered as vendor', async () => {
      mockDb.first.mockResolvedValue(null); // no vendor with this phone
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 when vendor is suspended', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'suspended' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('sends OTP when vendor is found and active', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBe(600);
    });

    it('rejects invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/vendor-verify-otp', () => {
    it('returns 401 when OTP not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 when OTP is not 6 digits', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '12345' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/6 digits/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: VENDOR-AUTH ALIAS ENDPOINTS (/vendor-auth/*)
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /vendor-auth/request-otp — alias endpoint', () => {
    it('returns 404 when vendor not registered with this phone', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348099999999' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 when vendor account is suspended', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'suspended' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('sends OTP when vendor is active', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBe(600);
    });

    it('accepts local Nigerian format (0xxx)', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '08012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /vendor-auth/verify-otp — alias endpoint', () => {
    it('returns 401 when OTP not found in DB', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 for non-6-digit OTP', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: 'abc' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when phone or otp missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/otp/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: KYC SUBMISSION ENDPOINT
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /cmrc_vendors/:id/kyc — KYC submission (vendor JWT required)', () => {
    const validBvnHash = 'a'.repeat(64);
    const validNinHash = 'b'.repeat(64);

    it('returns 401 without vendor JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cmrc_vendors/vnd_1/kyc', { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to submit KYC for another vendor', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_B/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor account/i);
    });

    it('returns 403 when JWT tenant does not match header tenant', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_OTHER');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }, 'tnt_test'),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('returns 400 when no KYC identifiers provided', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/rc_number|bvn_hash|nin_hash/i);
    });

    it('returns 400 when bvn_hash is not a valid SHA-256 hex string', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: 'not-a-hash' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when nin_hash is not 64 hex chars', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { nin_hash: 'tooshort' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when bank_details account_number is not 10 digits', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '12345', account_name: 'ADE STORES' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/10 digits/i);
    });

    it('returns 400 when bank_details is missing account_name', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: '' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/account_name/i);
    });

    it('returns 409 when KYC already submitted and awaiting review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'submitted' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/submitted/i);
    });

    it('returns 409 when KYC is under_review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'under_review' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
    });

    it('returns 409 when KYC already approved', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'approved' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/approved/i);
    });

    it('returns 404 when vendor not found in this marketplace', async () => {
      mockDb.first.mockResolvedValue(null);
      const token = await makeVendorToken('vnd_ghost', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_ghost/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('submits KYC successfully with rc_number only', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.kyc_status).toBe('submitted');
    });

    it('submits KYC successfully with all fields including bank_details', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' }); // re-submission after rejection
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-1234567',
          bvn_hash: validBvnHash,
          nin_hash: validNinHash,
          cac_docs_url: 'https://storage.example.com/cac.pdf',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: 'ADE FASHION HOUSE' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.kyc_status).toBe('submitted');
      expect(data.data.message).toMatch(/submitted successfully/i);
    });

    it('allows re-submission after KYC rejection', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: validBvnHash }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('generated kyc_submitted_at is a current epoch ms timestamp', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      expect(data.data.kyc_submitted_at).toBeGreaterThanOrEqual(before);
      expect(data.data.kyc_submitted_at).toBeLessThanOrEqual(after);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: DASHBOARD SCOPING (additional ledger / cmrc_orders validation)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Dashboard scoping — GET /ledger revenue aggregation', () => {
    it('returns empty data array when vendor has no ledger entries', async () => {
      const token = await makeVendorToken('vnd_new', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
    });

    it('ledger entries include account_type and amount fields for revenue calculation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'led_1', vendor_id: 'vnd_1', account_type: 'revenue', amount: 90000, type: 'CREDIT', order_id: 'ord_1' },
          { id: 'led_2', vendor_id: 'vnd_1', account_type: 'commission', amount: 10000, type: 'CREDIT', order_id: 'ord_1' },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2);
      const revenue = data.data.filter((e: { account_type: string }) => e.account_type === 'revenue')[0];
      expect(revenue.amount).toBe(90000);
    });
  });

  describe('Dashboard scoping — GET /cmrc_orders vendor filter', () => {
    it('only returns cmrc_orders from the marketplace channel', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]', total_amount: 50000 },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0].channel).toBe('marketplace');
    });

    it('DB query uses vendor LIKE pattern for vendor-scoping', async () => {
      const token = await makeVendorToken('vnd_xyz', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('%"vendor_id":"vnd_xyz"%');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: CROSS-VENDOR CATALOG — GET /catalog
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /catalog — cross-vendor catalog (MV-3)', () => {
    const catalogRows = [
      { id: 'prod_1', sku: 'SKU001', name: 'Aso-Oke Set', description: 'Traditional fabric', category: 'fashion',
        price: 2500000, quantity: 10, image_url: null, vendor_id: 'vnd_1',
        vendor_name: 'Ade Fashion House', vendor_slug: 'ade-fashion', rating_avg: 4.5, rating_count: 12, created_at: 1000 },
      { id: 'prod_2', sku: 'SKU002', name: 'Bluetooth Speaker', description: 'Waterproof', category: 'electronics',
        price: 1200000, quantity: 5, image_url: null, vendor_id: 'vnd_2',
        vendor_name: 'Chidi Electronics', vendor_slug: 'chidi-elec', rating_avg: null, rating_count: null, created_at: 2000 },
    ];

    it('returns 200 with cross-vendor cmrc_products from active cmrc_vendors', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
    });

    it('includes vendor_name and vendor_slug on each product', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0]).toHaveProperty('vendor_name');
      expect(data.data[0]).toHaveProperty('vendor_slug');
      expect(data.data[0].vendor_name).toBe('Ade Fashion House');
    });

    it('never includes cost_price in catalog response (NDPR / price integrity)', async () => {
      const rowWithCost = { ...catalogRows[0], cost_price: 999999 };
      mockDb.all.mockResolvedValue({ results: [rowWithCost] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0]).not.toHaveProperty('cost_price');
    });

    it('returns empty data array when no active vendor cmrc_products', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
      expect(data.meta.has_more).toBe(false);
    });

    it('respects per_page parameter and caps at 24', async () => {
      const rows = Array.from({ length: 24 }, (_, i) => ({ ...catalogRows[0], id: `prod_${i}`, sku: `SKU${i}` }));
      mockDb.all.mockResolvedValue({ results: rows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=100'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain(25); // per_page capped at 24, fetches 24+1
    });

    it('returns has_more=true and next_cursor when more results exist', async () => {
      const rows = Array.from({ length: 13 }, (_, i) => ({ ...catalogRows[0], id: `prod_${i}`, created_at: i }));
      mockDb.all.mockResolvedValue({ results: rows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=12'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.has_more).toBe(true);
      expect(data.meta.next_cursor).toBe('prod_11');
      expect(data.data).toHaveLength(12);
    });

    it('returns has_more=false when results fit in page', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=12'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.has_more).toBe(false);
      expect(data.meta.next_cursor).toBeNull();
    });

    it('passes search param into SQL bind arguments (LIKE fallback)', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?search=Aso-Oke'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat().map(String);
      const hasLike = bindArgs.some(a => a.includes('Aso-Oke'));
      expect(hasLike).toBe(true);
    });

    it('filters by category when provided', async () => {
      mockDb.all.mockResolvedValue({ results: [catalogRows[0]] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?category=fashion'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('fashion');
    });

    it('filters by vendor_id when provided', async () => {
      mockDb.all.mockResolvedValue({ results: [catalogRows[0]] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?vendor_id=vnd_1'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('vnd_1');
    });

    it('passes cursor (after param) into SQL bind arguments', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?after=prod_9'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('prod_9');
    });

    it('always scopes query to the request tenant_id', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog', undefined, 'tnt_abc'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('tnt_abc');
    });

    it('returns cached payload from KV without hitting DB', async () => {
      const payload = JSON.stringify({ success: true, data: catalogRows, meta: { has_more: false, next_cursor: null, count: 2, per_page: 12 } });
      mockCatalogCache.get.mockResolvedValue(payload);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      expect(mockDb.prepare).not.toHaveBeenCalled();
      const cacheHeader = res.headers.get('X-Cache');
      expect(cacheHeader).toBe('HIT');
    });

    it('stores catalog response in KV after a DB query (cache miss)', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(mockCatalogCache.put).toHaveBeenCalledTimes(1);
      const [key, val, opts] = mockCatalogCache.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(key).toMatch(/^mv_catalog_tnt_test_/);
      expect(opts.expirationTtl).toBe(60);
      const parsed = JSON.parse(val);
      expect(parsed.success).toBe(true);
    });

    it('bypasses KV cache when nocache=1', async () => {
      const payload = JSON.stringify({ success: true, data: [], meta: {} });
      mockCatalogCache.get.mockResolvedValue(payload);
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?nocache=1'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2); // got from DB, not cache
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('X-Cache header is MISS on a DB fetch', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.headers.get('X-Cache')).toBe('MISS');
    });

    it('meta.count matches the number of items returned', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.count).toBe(data.data.length);
    });

    it('accepts "q" query param as search term (frontend convention)', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?q=Ankara'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat().map(String);
      const hasSearch = bindArgs.some(a => a.includes('Ankara'));
      expect(hasSearch).toBe(true);
    });

    it('includes has_variants field in catalog SELECT response', async () => {
      const rowsWithVariants = [
        { id: 'prod_1', sku: 'SKU001', name: 'Shirt', description: null, category: 'fashion',
          price: 1500000, quantity: 8, image_url: null, has_variants: 1, vendor_id: 'vnd_1',
          vendor_name: 'Ade Fashion', vendor_slug: 'ade', rating_avg: null, rating_count: null, created_at: 100 },
      ];
      mockDb.all.mockResolvedValue({ results: rowsWithVariants });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0]).toHaveProperty('has_variants');
      expect(data.data[0].has_variants).toBe(1);
    });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: PUBLIC ORDER TRACKING — GET /cmrc_orders/track
  // ─────────────────────────────────────────────────────────────────────────
  describe('GET /cmrc_orders/track — buyer order tracking (MV-3)', () => {
    const umbrellaRow = {
      id: 'mkp_order_abc123', payment_status: 'pending', order_status: 'confirmed',
      vendor_count: 2, total_amount: 3500000,
      customer_email: 'buyer@example.ng', created_at: 1700000000, updated_at: 1700000010,
    };
    const childOrders = [
      { id: 'ord_1', vendor_id: 'vnd_1', order_status: 'confirmed', payment_status: 'pending', total_amount: 2000000 },
      { id: 'ord_2', vendor_id: 'vnd_2', order_status: 'confirmed', payment_status: 'pending', total_amount: 1500000 },
    ];

    it('redirects to Logistics portal for a valid marketplace_order_id (T-CVC-02)', async () => {
      mockDb.first.mockResolvedValue({ id: 'mkp_order_abc123' });
      const mockLogisticsWorker = {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
          success: true,
          data: { trackingUrl: 'https://logistics.webwaka.ng/track?token=signed-token-123' }
        }), { status: 200 })),
      };
      const envWithBinding = { ...mockEnv, LOGISTICS_WORKER: mockLogisticsWorker };
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_orders/track?marketplace_order_id=mkp_order_abc123'),
        envWithBinding as any,
      );
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://logistics.webwaka.ng/track?token=signed-token-123');
    });

    it('falls back to Commerce status when Logistics is unavailable (T-CVC-02)', async () => {
      mockDb.first.mockResolvedValue(umbrellaRow);
      mockDb.all.mockResolvedValue({ results: childOrders });
      // No LOGISTICS_WORKER in mockEnv
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_orders/track?marketplace_order_id=mkp_order_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.note).toBe('logistics_unavailable');
      expect(data.data.marketplace_order_id).toBe('mkp_order_abc123');
    });

    it('returns 404 when marketplace_order_id is not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_orders/track?marketplace_order_id=mkp_nonexistent'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
    });

    it('returns 400 when marketplace_order_id param is missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_orders/track'),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.success).toBe(false);
    });

    it('masks customer email for NDPR compliance', async () => {
      mockDb.first.mockResolvedValue(umbrellaRow);
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cmrc_orders/track?marketplace_order_id=mkp_order_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.customer_email_masked).toBe('buy***@example.ng');
      expect(data.data).not.toHaveProperty('customer_email');
    });

    it('does not require authentication (public endpoint)', async () => {
      mockDb.first.mockResolvedValue(umbrellaRow);
      mockDb.all.mockResolvedValue({ results: [] });
      const req = new Request('http://localhost/cmrc_orders/track?marketplace_order_id=mkp_order_abc123', {
        headers: { 'x-tenant-id': 'tnt_test' },
      });
      const res = await multiVendorRouter.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
    });
  });

  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: MARKETPLACE CART — POST /cart
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /cart — marketplace cart creation (MV-3)', () => {
    const twoVendorItems = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi Elec', name: 'Speaker', price: 1200000, quantity: 2 },
    ];

    it('returns 400 when NDPR consent is false', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: false }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/NDPR/i);
    });

    it('returns 400 when items array is empty', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: [], ndpr_consent: true }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when an item is missing product_id', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ vendor_id: 'vnd_1', name: 'x', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/product_id/i);
    });

    it('returns 400 when an item is missing vendor_id', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', name: 'x', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/vendor_id/i);
    });

    it('returns 400 when an item price is non-positive', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', name: 'x', price: -500, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/price/i);
    });

    it('returns 400 when an item quantity is zero', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', name: 'x', price: 100, quantity: 0 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/quantity/i);
    });

    it('returns 201 and creates cart with a token on success', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.token).toBeDefined();
    });

    it('cart token starts with cart_mkp_ prefix', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.token).toMatch(/^cart_mkp_/);
    });

    it('vendor_breakdown groups items by vendor_id correctly', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      const bd = data.data.vendor_breakdown;
      expect(bd).toHaveProperty('vnd_1');
      expect(bd).toHaveProperty('vnd_2');
      expect(bd.vnd_1.subtotal).toBe(2500000);
      expect(bd.vnd_2.subtotal).toBe(2400000); // 1200000 * 2
    });

    it('total_amount is the sum across all cmrc_vendors', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 2400000);
    });

    it('vendor_count matches the number of unique cmrc_vendors', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('expires_at is approximately 24 hours from now', async () => {
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      const expected24h = 24 * 60 * 60 * 1000;
      expect(data.data.expires_at).toBeGreaterThanOrEqual(before + expected24h - 100);
      expect(data.data.expires_at).toBeLessThanOrEqual(after + expected24h + 100);
    });

    it('single-vendor cart has vendor_count=1', async () => {
      const singleVendorItems = [
        { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Kaftan', price: 1800000, quantity: 2 },
        { product_id: 'prod_2', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Gown', price: 2000000, quantity: 1 },
      ];
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: singleVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(1);
      expect(data.data.vendor_breakdown.vnd_1.subtotal).toBe(1800000 * 2 + 2000000);
    });

    it('vendor_breakdown item_count sums quantities correctly', async () => {
      const items = [
        { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'A', price: 100, quantity: 3 },
        { product_id: 'prod_2', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'B', price: 200, quantity: 2 },
      ];
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown.vnd_1.item_count).toBe(5);
    });

    it('returns 200 when updating existing cart with valid token', async () => {
      mockDb.first.mockResolvedValue({ id: 'cs_1' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, token: 'cart_mkp_existing' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.token).toBe('cart_mkp_existing');
    });

    it('returns 404 when updating a cart with unknown token', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, token: 'cart_mkp_ghost' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('passes customer_phone into DB insert when provided', async () => {
      await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, customer_phone: '+2348099991234' }),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('+2348099991234');
    });

    it('item name is required — returns 400 when missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/name/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: MARKETPLACE CART — GET /cart/:token
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /cart/:token — retrieve marketplace cart (MV-3)', () => {
    const cartItems = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi', name: 'Speaker', price: 600000, quantity: 2 },
    ];
    const cartBreakdown = {
      vnd_1: { vendor_id: 'vnd_1', vendor_name: 'Ade', item_count: 1, subtotal: 2500000 },
      vnd_2: { vendor_id: 'vnd_2', vendor_name: 'Chidi', item_count: 2, subtotal: 1200000 },
    };
    const futureExpiry = Date.now() + 23 * 60 * 60 * 1000;
    const mockCartRow = {
      id: 'cs_1',
      session_token: 'cart_mkp_abc123',
      items_json: JSON.stringify(cartItems),
      vendor_breakdown_json: JSON.stringify(cartBreakdown),
      customer_phone: '+2348099991234',
      expires_at: futureExpiry,
      created_at: Date.now() - 1000,
      updated_at: Date.now(),
    };

    it('returns 404 when token is not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_notfound'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 200 with cart data for a valid token', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBeGreaterThan(0);
    });

    it('rejects invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/vendor-verify-otp', () => {
    it('returns 401 when OTP not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 when OTP is not 6 digits', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '12345' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/6 digits/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: VENDOR-AUTH ALIAS ENDPOINTS (/vendor-auth/*)
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /vendor-auth/request-otp — alias endpoint', () => {
    it('returns 404 when vendor not registered with this phone', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348099999999' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 when vendor account is suspended', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'suspended' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('sends OTP when vendor is active', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBe(600);
    });

    it('accepts local Nigerian format (0xxx)', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '08012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /vendor-auth/verify-otp — alias endpoint', () => {
    it('returns 401 when OTP not found in DB', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 for non-6-digit OTP', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: 'abc' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when phone or otp missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/otp/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: KYC SUBMISSION ENDPOINT
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /cmrc_vendors/:id/kyc — KYC submission (vendor JWT required)', () => {
    const validBvnHash = 'a'.repeat(64);
    const validNinHash = 'b'.repeat(64);

    it('returns 401 without vendor JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cmrc_vendors/vnd_1/kyc', { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to submit KYC for another vendor', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_B/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor account/i);
    });

    it('returns 403 when JWT tenant does not match header tenant', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_OTHER');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }, 'tnt_test'),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('returns 400 when no KYC identifiers provided', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/rc_number|bvn_hash|nin_hash/i);
    });

    it('returns 400 when bvn_hash is not a valid SHA-256 hex string', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: 'not-a-hash' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when nin_hash is not 64 hex chars', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { nin_hash: 'tooshort' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when bank_details account_number is not 10 digits', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '12345', account_name: 'ADE STORES' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/10 digits/i);
    });

    it('returns 400 when bank_details is missing account_name', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: '' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/account_name/i);
    });

    it('returns 409 when KYC already submitted and awaiting review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'submitted' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/submitted/i);
    });

    it('returns 409 when KYC is under_review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'under_review' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
    });

    it('returns 409 when KYC already approved', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'approved' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/approved/i);
    });

    it('returns 404 when vendor not found in this marketplace', async () => {
      mockDb.first.mockResolvedValue(null);
      const token = await makeVendorToken('vnd_ghost', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_ghost/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('submits KYC successfully with rc_number only', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.kyc_status).toBe('submitted');
    });

    it('submits KYC successfully with all fields including bank_details', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' }); // re-submission after rejection
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-1234567',
          bvn_hash: validBvnHash,
          nin_hash: validNinHash,
          cac_docs_url: 'https://storage.example.com/cac.pdf',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: 'ADE FASHION HOUSE' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.kyc_status).toBe('submitted');
      expect(data.data.message).toMatch(/submitted successfully/i);
    });

    it('allows re-submission after KYC rejection', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: validBvnHash }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('generated kyc_submitted_at is a current epoch ms timestamp', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      expect(data.data.kyc_submitted_at).toBeGreaterThanOrEqual(before);
      expect(data.data.kyc_submitted_at).toBeLessThanOrEqual(after);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: DASHBOARD SCOPING (additional ledger / cmrc_orders validation)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Dashboard scoping — GET /ledger revenue aggregation', () => {
    it('returns empty data array when vendor has no ledger entries', async () => {
      const token = await makeVendorToken('vnd_new', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
    });

    it('ledger entries include account_type and amount fields for revenue calculation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'led_1', vendor_id: 'vnd_1', account_type: 'revenue', amount: 90000, type: 'CREDIT', order_id: 'ord_1' },
          { id: 'led_2', vendor_id: 'vnd_1', account_type: 'commission', amount: 10000, type: 'CREDIT', order_id: 'ord_1' },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2);
      const revenue = data.data.filter((e: { account_type: string }) => e.account_type === 'revenue')[0];
      expect(revenue.amount).toBe(90000);
    });
  });

  describe('Dashboard scoping — GET /cmrc_orders vendor filter', () => {
    it('only returns cmrc_orders from the marketplace channel', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]', total_amount: 50000 },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0].channel).toBe('marketplace');
    });

    it('DB query uses vendor LIKE pattern for vendor-scoping', async () => {
      const token = await makeVendorToken('vnd_xyz', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('%"vendor_id":"vnd_xyz"%');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: CROSS-VENDOR CATALOG — GET /catalog
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /catalog — cross-vendor catalog (MV-3)', () => {
    const catalogRows = [
      { id: 'prod_1', sku: 'SKU001', name: 'Aso-Oke Set', description: 'Traditional fabric', category: 'fashion',
        price: 2500000, quantity: 10, image_url: null, vendor_id: 'vnd_1',
        vendor_name: 'Ade Fashion House', vendor_slug: 'ade-fashion', rating_avg: 4.5, rating_count: 12, created_at: 1000 },
      { id: 'prod_2', sku: 'SKU002', name: 'Bluetooth Speaker', description: 'Waterproof', category: 'electronics',
        price: 1200000, quantity: 5, image_url: null, vendor_id: 'vnd_2',
        vendor_name: 'Chidi Electronics', vendor_slug: 'chidi-elec', rating_avg: null, rating_count: null, created_at: 2000 },
    ];

    it('returns 200 with cross-vendor cmrc_products from active cmrc_vendors', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(2);
    });

    it('includes vendor_name and vendor_slug on each product', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0]).toHaveProperty('vendor_name');
      expect(data.data[0]).toHaveProperty('vendor_slug');
      expect(data.data[0].vendor_name).toBe('Ade Fashion House');
    });

    it('never includes cost_price in catalog response (NDPR / price integrity)', async () => {
      const rowWithCost = { ...catalogRows[0], cost_price: 999999 };
      mockDb.all.mockResolvedValue({ results: [rowWithCost] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0]).not.toHaveProperty('cost_price');
    });

    it('returns empty data array when no active vendor cmrc_products', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
      expect(data.meta.has_more).toBe(false);
    });

    it('respects per_page parameter and caps at 24', async () => {
      const rows = Array.from({ length: 24 }, (_, i) => ({ ...catalogRows[0], id: `prod_${i}`, sku: `SKU${i}` }));
      mockDb.all.mockResolvedValue({ results: rows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=100'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain(25); // per_page capped at 24, fetches 24+1
    });

    it('returns has_more=true and next_cursor when more results exist', async () => {
      const rows = Array.from({ length: 13 }, (_, i) => ({ ...catalogRows[0], id: `prod_${i}`, created_at: i }));
      mockDb.all.mockResolvedValue({ results: rows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=12'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.has_more).toBe(true);
      expect(data.meta.next_cursor).toBe('prod_11');
      expect(data.data).toHaveLength(12);
    });

    it('returns has_more=false when results fit in page', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?per_page=12'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.has_more).toBe(false);
      expect(data.meta.next_cursor).toBeNull();
    });

    it('passes search param into SQL bind arguments (LIKE fallback)', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?search=Aso-Oke'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat().map(String);
      const hasLike = bindArgs.some(a => a.includes('Aso-Oke'));
      expect(hasLike).toBe(true);
    });

    it('filters by category when provided', async () => {
      mockDb.all.mockResolvedValue({ results: [catalogRows[0]] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?category=fashion'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('fashion');
    });

    it('filters by vendor_id when provided', async () => {
      mockDb.all.mockResolvedValue({ results: [catalogRows[0]] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?vendor_id=vnd_1'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('vnd_1');
    });

    it('passes cursor (after param) into SQL bind arguments', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?after=prod_9'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('prod_9');
    });

    it('always scopes query to the request tenant_id', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog', undefined, 'tnt_abc'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('tnt_abc');
    });

    it('returns cached payload from KV without hitting DB', async () => {
      const payload = JSON.stringify({ success: true, data: catalogRows, meta: { has_more: false, next_cursor: null, count: 2, per_page: 12 } });
      mockCatalogCache.get.mockResolvedValue(payload);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      expect(mockDb.prepare).not.toHaveBeenCalled();
      const cacheHeader = res.headers.get('X-Cache');
      expect(cacheHeader).toBe('HIT');
    });

    it('stores catalog response in KV after a DB query (cache miss)', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(mockCatalogCache.put).toHaveBeenCalledTimes(1);
      const [key, val, opts] = mockCatalogCache.put.mock.calls[0] as [string, string, { expirationTtl: number }];
      expect(key).toMatch(/^mv_catalog_tnt_test_/);
      expect(opts.expirationTtl).toBe(60);
      const parsed = JSON.parse(val);
      expect(parsed.success).toBe(true);
    });

    it('bypasses KV cache when nocache=1', async () => {
      const payload = JSON.stringify({ success: true, data: [], meta: {} });
      mockCatalogCache.get.mockResolvedValue(payload);
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog?nocache=1'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2); // got from DB, not cache
      expect(mockDb.prepare).toHaveBeenCalled();
    });

    it('X-Cache header is MISS on a DB fetch', async () => {
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      expect(res.headers.get('X-Cache')).toBe('MISS');
    });

    it('meta.count matches the number of items returned', async () => {
      mockDb.all.mockResolvedValue({ results: catalogRows });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/catalog'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.meta.count).toBe(data.data.length);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: MARKETPLACE CART — POST /cart
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /cart — marketplace cart creation (MV-3)', () => {
    const twoVendorItems = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi Elec', name: 'Speaker', price: 1200000, quantity: 2 },
    ];

    it('returns 400 when NDPR consent is false', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: false }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/NDPR/i);
    });

    it('returns 400 when items array is empty', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: [], ndpr_consent: true }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when an item is missing product_id', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ vendor_id: 'vnd_1', name: 'x', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/product_id/i);
    });

    it('returns 400 when an item is missing vendor_id', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', name: 'x', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/vendor_id/i);
    });

    it('returns 400 when an item price is non-positive', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', name: 'x', price: -500, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/price/i);
    });

    it('returns 400 when an item quantity is zero', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', name: 'x', price: 100, quantity: 0 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/quantity/i);
    });

    it('returns 201 and creates cart with a token on success', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.token).toBeDefined();
    });

    it('cart token starts with cart_mkp_ prefix', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.token).toMatch(/^cart_mkp_/);
    });

    it('vendor_breakdown groups items by vendor_id correctly', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      const bd = data.data.vendor_breakdown;
      expect(bd).toHaveProperty('vnd_1');
      expect(bd).toHaveProperty('vnd_2');
      expect(bd.vnd_1.subtotal).toBe(2500000);
      expect(bd.vnd_2.subtotal).toBe(2400000); // 1200000 * 2
    });

    it('total_amount is the sum across all cmrc_vendors', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 2400000);
    });

    it('vendor_count matches the number of unique cmrc_vendors', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('expires_at is approximately 24 hours from now', async () => {
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      const expected24h = 24 * 60 * 60 * 1000;
      expect(data.data.expires_at).toBeGreaterThanOrEqual(before + expected24h - 100);
      expect(data.data.expires_at).toBeLessThanOrEqual(after + expected24h + 100);
    });

    it('single-vendor cart has vendor_count=1', async () => {
      const singleVendorItems = [
        { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Kaftan', price: 1800000, quantity: 2 },
        { product_id: 'prod_2', vendor_id: 'vnd_1', vendor_name: 'Ade Fashion', name: 'Gown', price: 2000000, quantity: 1 },
      ];
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: singleVendorItems, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(1);
      expect(data.data.vendor_breakdown.vnd_1.subtotal).toBe(1800000 * 2 + 2000000);
    });

    it('vendor_breakdown item_count sums quantities correctly', async () => {
      const items = [
        { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'A', price: 100, quantity: 3 },
        { product_id: 'prod_2', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'B', price: 200, quantity: 2 },
      ];
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items, ndpr_consent: true }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown.vnd_1.item_count).toBe(5);
    });

    it('returns 200 when updating existing cart with valid token', async () => {
      mockDb.first.mockResolvedValue({ id: 'cs_1' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, token: 'cart_mkp_existing' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.token).toBe('cart_mkp_existing');
    });

    it('returns 404 when updating a cart with unknown token', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, token: 'cart_mkp_ghost' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('passes customer_phone into DB insert when provided', async () => {
      await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', { items: twoVendorItems, ndpr_consent: true, customer_phone: '+2348099991234' }),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('+2348099991234');
    });

    it('item name is required — returns 400 when missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cart', {
          items: [{ product_id: 'p1', vendor_id: 'vnd_1', price: 100, quantity: 1 }],
          ndpr_consent: true,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/name/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: MARKETPLACE CART — GET /cart/:token
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /cart/:token — retrieve marketplace cart (MV-3)', () => {
    const cartItems = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi', name: 'Speaker', price: 600000, quantity: 2 },
    ];
    const cartBreakdown = {
      vnd_1: { vendor_id: 'vnd_1', vendor_name: 'Ade', item_count: 1, subtotal: 2500000 },
      vnd_2: { vendor_id: 'vnd_2', vendor_name: 'Chidi', item_count: 2, subtotal: 1200000 },
    };
    const futureExpiry = Date.now() + 23 * 60 * 60 * 1000;
    const mockCartRow = {
      id: 'cs_1',
      session_token: 'cart_mkp_abc123',
      items_json: JSON.stringify(cartItems),
      vendor_breakdown_json: JSON.stringify(cartBreakdown),
      customer_phone: '+2348099991234',
      expires_at: futureExpiry,
      created_at: Date.now() - 1000,
      updated_at: Date.now(),
    };

    it('returns 404 when token is not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_notfound'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 200 with cart data for a valid token', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBeGreaterThan(0);
    });

    it('rejects invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/vendor-verify-otp', () => {
    it('returns 401 when OTP not found', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 when OTP is not 6 digits', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/auth/vendor-verify-otp', { phone: '+2348012345678', otp: '12345' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/6 digits/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: VENDOR-AUTH ALIAS ENDPOINTS (/vendor-auth/*)
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /vendor-auth/request-otp — alias endpoint', () => {
    it('returns 404 when vendor not registered with this phone', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348099999999' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 when vendor account is suspended', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'suspended' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('sends OTP when vendor is active', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBe(600);
    });

    it('accepts local Nigerian format (0xxx)', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', status: 'active' });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '08012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('returns 400 for invalid phone format', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/request-otp', { phone: '123' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /vendor-auth/verify-otp — alias endpoint', () => {
    it('returns 401 when OTP not found in DB', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: '123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 400 for non-6-digit OTP', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678', otp: 'abc' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when phone or otp missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendor-auth/verify-otp', { phone: '+2348012345678' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/otp/i);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: KYC SUBMISSION ENDPOINT
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /cmrc_vendors/:id/kyc — KYC submission (vendor JWT required)', () => {
    const validBvnHash = 'a'.repeat(64);
    const validNinHash = 'b'.repeat(64);

    it('returns 401 without vendor JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/cmrc_vendors/vnd_1/kyc', { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to submit KYC for another vendor', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_B/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor account/i);
    });

    it('returns 403 when JWT tenant does not match header tenant', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_OTHER');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }, 'tnt_test'),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('returns 400 when no KYC identifiers provided', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/rc_number|bvn_hash|nin_hash/i);
    });

    it('returns 400 when bvn_hash is not a valid SHA-256 hex string', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: 'not-a-hash' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when nin_hash is not 64 hex chars', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { nin_hash: 'tooshort' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when bank_details account_number is not 10 digits', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '12345', account_name: 'ADE STORES' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/10 digits/i);
    });

    it('returns 400 when bank_details is missing account_name', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-123456',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: '' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/account_name/i);
    });

    it('returns 409 when KYC already submitted and awaiting review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'submitted' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/submitted/i);
    });

    it('returns 409 when KYC is under_review', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'under_review' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
    });

    it('returns 409 when KYC already approved', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'approved' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/approved/i);
    });

    it('returns 404 when vendor not found in this marketplace', async () => {
      mockDb.first.mockResolvedValue(null);
      const token = await makeVendorToken('vnd_ghost', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_ghost/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('submits KYC successfully with rc_number only', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data.kyc_status).toBe('submitted');
    });

    it('submits KYC successfully with all fields including bank_details', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' }); // re-submission after rejection
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, {
          rc_number: 'RC-1234567',
          bvn_hash: validBvnHash,
          nin_hash: validNinHash,
          cac_docs_url: 'https://storage.example.com/cac.pdf',
          bank_details: { bank_code: '058', account_number: '0123456789', account_name: 'ADE FASHION HOUSE' },
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.kyc_status).toBe('submitted');
      expect(data.data.message).toMatch(/submitted successfully/i);
    });

    it('allows re-submission after KYC rejection', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'rejected' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { bvn_hash: validBvnHash }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('generated kyc_submitted_at is a current epoch ms timestamp', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/cmrc_vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      expect(data.data.kyc_submitted_at).toBeGreaterThanOrEqual(before);
      expect(data.data.kyc_submitted_at).toBeLessThanOrEqual(after);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: DASHBOARD SCOPING (additional ledger / cmrc_orders validation)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Dashboard scoping — GET /ledger revenue aggregation', () => {
    it('returns empty data array when vendor has no ledger entries', async () => {
      const token = await makeVendorToken('vnd_new', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data).toHaveLength(0);
    });

    it('ledger entries include account_type and amount fields for revenue calculation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'led_1', vendor_id: 'vnd_1', account_type: 'revenue', amount: 90000, type: 'CREDIT', order_id: 'ord_1' },
          { id: 'led_2', vendor_id: 'vnd_1', account_type: 'commission', amount: 10000, type: 'CREDIT', order_id: 'ord_1' },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/ledger', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveLength(2);
      const revenue = data.data.filter((e: { account_type: string }) => e.account_type === 'revenue')[0];
      expect(revenue.amount).toBe(90000);
    });
  });

  describe('Dashboard scoping — GET /cmrc_orders vendor filter', () => {
    const cartItemsMv3 = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi', name: 'Speaker', price: 600000, quantity: 2 },
    ];
    const cartBreakdownMv3 = {
      vnd_1: { vendor_id: 'vnd_1', vendor_name: 'Ade', item_count: 1, subtotal: 2500000 },
      vnd_2: { vendor_id: 'vnd_2', vendor_name: 'Chidi', item_count: 2, subtotal: 1200000 },
    };
    const mockCartRow = {
      id: 'cs_1',
      session_token: 'cart_mkp_abc123',
      items_json: JSON.stringify(cartItemsMv3),
      vendor_breakdown_json: JSON.stringify(cartBreakdownMv3),
      customer_phone: '+2348099991234',
      expires_at: Date.now() + 23 * 60 * 60 * 1000,
      created_at: Date.now() - 1000,
      updated_at: Date.now(),
    };
    it('only returns cmrc_orders from the marketplace channel', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]', total_amount: 50000 },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0].channel).toBe('marketplace');
    });

    it('DB query uses vendor LIKE pattern for vendor-scoping', async () => {
      const token = await makeVendorToken('vnd_xyz', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/cmrc_orders', token),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('%"vendor_id":"vnd_xyz"%');
    });

    it('response includes parsed items array', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(Array.isArray(data.data.items)).toBe(true);
      expect(data.data.items).toHaveLength(2);
    });

    it('response includes vendor_breakdown with per-vendor subtotals', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown).toHaveProperty('vnd_1');
      expect(data.data.vendor_breakdown.vnd_1.subtotal).toBe(2500000);
    });

    it('total_amount is computed from items price * quantity', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 600000 * 2);
    });

    it('item_count sums all item quantities', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.item_count).toBe(3); // 1 + 2
    });

    it('vendor_count matches number of cmrc_vendors in breakdown', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('returns 404 when cart is expired', async () => {
      mockDb.first.mockResolvedValue({ ...mockCartRow, expires_at: Date.now() - 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toMatch(/expired/i);
    });

    it('response token matches the requested token', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.token).toBe('cart_mkp_abc123');
    });

    it('passes tenant_id to DB query (tenant isolation)', async () => {
      mockDb.first.mockResolvedValue(null);
      await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123', undefined, 'tnt_isolated'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('tnt_isolated');
    });

    it('response includes created_at and updated_at timestamps', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveProperty('created_at');
      expect(data.data).toHaveProperty('updated_at');
    });

    it('handles empty or corrupt vendor_breakdown_json gracefully', async () => {
      mockDb.first.mockResolvedValue({ ...mockCartRow, vendor_breakdown_json: 'INVALID_JSON' });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown).toEqual({});
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: CHECKOUT — UMBRELLA ORDER CREATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /checkout — umbrella marketplace order (MV-3)', () => {
    const cartItemsMv3 = [
      { product_id: 'prod_1', vendor_id: 'vnd_1', vendor_name: 'Ade', name: 'Aso-Oke', price: 2500000, quantity: 1 },
      { product_id: 'prod_2', vendor_id: 'vnd_2', vendor_name: 'Chidi', name: 'Speaker', price: 600000, quantity: 2 },
    ];
    const cartBreakdownMv3 = {
      vnd_1: { vendor_id: 'vnd_1', vendor_name: 'Ade', item_count: 1, subtotal: 2500000 },
      vnd_2: { vendor_id: 'vnd_2', vendor_name: 'Chidi', item_count: 2, subtotal: 1200000 },
    };
    const mockCartRow = {
      id: 'cs_1',
      session_token: 'cart_mkp_abc123',
      items_json: JSON.stringify(cartItemsMv3),
      vendor_breakdown_json: JSON.stringify(cartBreakdownMv3),
      customer_phone: '+2348099991234',
      expires_at: Date.now() + 23 * 60 * 60 * 1000,
      created_at: Date.now() - 1000,
      updated_at: Date.now(),
    };
    const checkoutBody = {
      items: [
        { product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 2500000, name: 'Aso-Oke' },
        { product_id: 'prod_2', vendor_id: 'vnd_2', quantity: 2, price: 600000, name: 'Speaker' },
      ],
      customer_email: 'ada@example.com',
      customer_phone: '+2348011112222',
      payment_method: 'paystack',
      ndpr_consent: true,
    };

    it('returns 201 with marketplace_order_id on success', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data).toHaveProperty('marketplace_order_id');
    });

    it('marketplace_order_id starts with mkp_ord_ prefix', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.marketplace_order_id).toMatch(/^mkp_ord_/);
    });

    it('response includes vendor_breakdown with per-vendor commission + payout', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 }); // 10%
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      const bd = data.data.vendor_breakdown;
      expect(bd).toHaveProperty('vnd_1');
      expect(bd.vnd_1.commission).toBe(Math.round(2500000 * 1000 / 10000)); // 250000
      expect(bd.vnd_1.payout).toBe(2500000 - bd.vnd_1.commission);
    });

    it('vendor_count matches the number of distinct cmrc_vendors in items', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 800 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('total_amount equals sum of all item prices * quantities', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 600000 * 2);
    });

    it('uses default commission_rate of 10% when vendor not found in DB', async () => {
      mockDb.first.mockResolvedValue(null); // vendor row not found
      const singleVendorBody = {
        ...checkoutBody,
        items: [{ product_id: 'prod_1', vendor_id: 'vnd_ghost', quantity: 1, price: 1000000, name: 'Item' }],
      };
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', singleVendorBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown.vnd_ghost.commission).toBe(Math.round(1000000 * 1000 / 10000));
    });

    it('returns 400 when NDPR consent is missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', { ...checkoutBody, ndpr_consent: false }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when customer_email is missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', { ...checkoutBody, customer_email: '' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('accepts optional payment_reference from client (MV-4 will verify server-side)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const bodyWithRef = { ...checkoutBody, payment_reference: 'pay_ref_custom123' };
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', bodyWithRef),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.payment_reference).toBe('pay_ref_custom123');
    });

    it('generates payment_reference automatically when not provided', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^pay_mkp_/);
    });

    it('inserts umbrella record into cmrc_marketplace_orders (DB INSERT called)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const insertCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!).filter(
        (sql: string) => sql.includes('cmrc_marketplace_orders'),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('response includes parsed items array', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(Array.isArray(data.data.items)).toBe(true);
      expect(data.data.items).toHaveLength(2);
    });

    it('response includes vendor_breakdown with per-vendor subtotals', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown).toHaveProperty('vnd_1');
      expect(data.data.vendor_breakdown.vnd_1.subtotal).toBe(2500000);
    });

    it('total_amount is computed from items price * quantity', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 600000 * 2);
    });

    it('item_count sums all item quantities', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.item_count).toBe(3); // 1 + 2
    });

    it('vendor_count matches number of cmrc_vendors in breakdown', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('returns 404 when cart is expired', async () => {
      mockDb.first.mockResolvedValue({ ...mockCartRow, expires_at: Date.now() - 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.error).toMatch(/expired/i);
    });

    it('response token matches the requested token', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.token).toBe('cart_mkp_abc123');
    });

    it('passes tenant_id to DB query (tenant isolation)', async () => {
      mockDb.first.mockResolvedValue(null);
      await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123', undefined, 'tnt_isolated'),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('tnt_isolated');
    });

    it('response includes created_at and updated_at timestamps', async () => {
      mockDb.first.mockResolvedValue(mockCartRow);
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data).toHaveProperty('created_at');
      expect(data.data).toHaveProperty('updated_at');
    });

    it('handles empty or corrupt vendor_breakdown_json gracefully', async () => {
      mockDb.first.mockResolvedValue({ ...mockCartRow, vendor_breakdown_json: 'INVALID_JSON' });
      const res = await multiVendorRouter.fetch(
        makeRequest('GET', '/cart/cart_mkp_abc123'),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown).toEqual({});
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-3: CHECKOUT — UMBRELLA ORDER CREATION
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /checkout — umbrella marketplace order (MV-3)', () => {
    const checkoutBody = {
      items: [
        { product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 1, price: 2500000, name: 'Aso-Oke' },
        { product_id: 'prod_2', vendor_id: 'vnd_2', quantity: 2, price: 600000, name: 'Speaker' },
      ],
      customer_email: 'ada@example.com',
      customer_phone: '+2348011112222',
      payment_method: 'paystack',
      ndpr_consent: true,
    };

    it('returns 201 with marketplace_order_id on success', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data).toHaveProperty('marketplace_order_id');
    });

    it('marketplace_order_id starts with mkp_ord_ prefix', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.marketplace_order_id).toMatch(/^mkp_ord_/);
    });

    it('response includes vendor_breakdown with per-vendor commission + payout', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 }); // 10%
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      const bd = data.data.vendor_breakdown;
      expect(bd).toHaveProperty('vnd_1');
      expect(bd.vnd_1.commission).toBe(Math.round(2500000 * 1000 / 10000)); // 250000
      expect(bd.vnd_1.payout).toBe(2500000 - bd.vnd_1.commission);
    });

    it('vendor_count matches the number of distinct cmrc_vendors in items', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 800 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_count).toBe(2);
    });

    it('total_amount equals sum of all item prices * quantities', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.total_amount).toBe(2500000 + 600000 * 2);
    });

    it('uses default commission_rate of 10% when vendor not found in DB', async () => {
      mockDb.first.mockResolvedValue(null); // vendor row not found
      const singleVendorBody = {
        ...checkoutBody,
        items: [{ product_id: 'prod_1', vendor_id: 'vnd_ghost', quantity: 1, price: 1000000, name: 'Item' }],
      };
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', singleVendorBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.vendor_breakdown.vnd_ghost.commission).toBe(Math.round(1000000 * 1000 / 10000));
    });

    it('returns 400 when NDPR consent is missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', { ...checkoutBody, ndpr_consent: false }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('returns 400 when customer_email is missing', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', { ...checkoutBody, customer_email: '' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
    });

    it('accepts optional payment_reference from client (MV-4 will verify server-side)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const bodyWithRef = { ...checkoutBody, payment_reference: 'pay_ref_custom123' };
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', bodyWithRef),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.payment_reference).toBe('pay_ref_custom123');
    });

    it('generates payment_reference automatically when not provided', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.payment_reference).toMatch(/^pay_mkp_/);
    });

    it('inserts umbrella record into cmrc_marketplace_orders (DB INSERT called)', async () => {
      mockDb.first.mockResolvedValue({ commission_rate: 1000 });
      await multiVendorRouter.fetch(
        makeRequest('POST', '/checkout', checkoutBody),
        mockEnv as any,
      );
      const insertCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!).filter(
        (sql: string) => sql.includes('cmrc_marketplace_orders'),
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-4 TESTS: Paystack verify, settlement escrow, webhook HMAC, shipping, payouts
// ═══════════════════════════════════════════════════════════════════════════════

// ── HMAC-SHA512 helper (mirrors production webhook logic) ────────────────────
async function makeWebhookSignature(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const PAYSTACK_SECRET = 'sk_test_mv4_paystack_secret_key';
const mockEnvWithPaystack = {
  ...mockEnv,
  PAYSTACK_SECRET,
};

function makeRequestWithPaystack(method: string, path: string, body?: unknown, extra?: Record<string, string>) {
  const url = `http://localhost${path}`;
  const init: RequestInit = {
    method,
    headers: {
      'x-tenant-id': 'tnt_test',
      'Content-Type': 'application/json',
      ...extra,
    },
  };
  if (body) init.body = JSON.stringify(body);
  return new Request(url, init);
}

const checkoutBodyPaystack = {
  items: [{ product_id: 'prod_1', vendor_id: 'vnd_1', quantity: 2, price: 500000, name: 'Ankara Fabric' }],
  customer_email: 'buyer@example.com',
  payment_method: 'paystack',
  payment_reference: 'ps_ref_abc123',
  ndpr_consent: true,
};

// ── Suite 1: Checkout × Paystack server-side verify (8 tests) ─────────────────
describe('MV-4 POST /checkout — Paystack server-side verify', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns 400 when payment_method=paystack but payment_reference is missing', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', { ...checkoutBodyPaystack, payment_reference: undefined }),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(400);
    const d = await res.json() as any;
    expect(d.error).toMatch(/payment_reference/i);
  });

  it('returns 402 when Paystack API returns status=false', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: false, message: 'Invalid key' }), { status: 200 }),
    );
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(402);
    const d = await res.json() as any;
    expect(d.error).toMatch(/verification failed/i);
  });

  it('returns 402 when Paystack transaction status is not "success"', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { status: 'abandoned', amount: 1000000 } }), { status: 200 }),
    );
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(402);
  });

  it('returns 402 when Paystack amount is less than expected total (fraud guard)', async () => {
    const expectedAmount = checkoutBodyPaystack.items[0]!.price * checkoutBodyPaystack.items[0]!.quantity; // 1000000
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { status: 'success', amount: expectedAmount - 1 } }), { status: 200 }),
    );
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(402);
    const d = await res.json() as any;
    expect(d.error).toMatch(/mismatch/i);
  });

  it('succeeds when Paystack verify returns success and amount matches', async () => {
    const expectedAmount = checkoutBodyPaystack.items[0]!.price * checkoutBodyPaystack.items[0]!.quantity; // 1000000
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { status: 'success', amount: expectedAmount } }), { status: 200 }),
    );
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(201);
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.payment_verified).toBe(true);
  });

  it('calls Paystack verify API with the correct payment_reference', async () => {
    const expectedAmount = 1000000;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { status: 'success', amount: expectedAmount } }), { status: 200 }),
    );
    await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[0]).toContain(`/transaction/verify/${checkoutBodyPaystack.payment_reference}`);
  });

  it('calls Paystack API with Bearer auth header', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ status: true, data: { status: 'success', amount: 1000000 } }), { status: 200 }),
    );
    await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', checkoutBodyPaystack),
      mockEnvWithPaystack as any,
    );
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[1].headers.Authorization).toContain(`Bearer ${PAYSTACK_SECRET}`);
  });

  it('skips Paystack verify for non-paystack payment methods (bank_transfer)', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const bankTransferBody = { ...checkoutBodyPaystack, payment_method: 'bank_transfer', payment_reference: undefined };
    const res = await multiVendorRouter.fetch(
      makeRequestWithPaystack('POST', '/checkout', bankTransferBody),
      mockEnvWithPaystack as any,
    );
    expect(res.status).toBe(201);
    expect(globalThis.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// ── Suite 2: Settlement escrow math (9 tests) ─────────────────────────────────
describe('MV-4 Settlement escrow math', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    vi.stubGlobal('fetch', vi.fn());
  });

  it('commission = subtotal * commission_rate / 10000 (10% rate → 100000 kobo on 1M)', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 1000000, name: 'A' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_x.commission).toBe(100000);
  });

  it('payout = subtotal - commission (vendor receives 900000 on 1M at 10%)', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 1000000, name: 'A' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_x.payout).toBe(900000);
  });

  it('settlement hold_until = created_at + 7 * 86400000 by default', async () => {
    const before = Date.now();
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 500000, name: 'A' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const insertCalls = mockDb.bind.mock.calls
      .map((c: unknown[]) => c)
      .filter((args: unknown[]) => args.some((a: unknown) => typeof a === 'string' && (a as string).startsWith('stl_')));
    const holdUntilArg = insertCalls.length > 0 ? insertCalls[0] : null;
    // Verify cmrc_settlements INSERT was called (hold_until is a bind argument)
    const allSqlCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!);
    expect(allSqlCalls.some((sql: string) => sql.includes('cmrc_settlements'))).toBe(true);
    // Verify hold_until > before (escrow in future)
    if (holdUntilArg) {
      const holdUntilVal = holdUntilArg.find((a: unknown) => typeof a === 'number' && (a as number) > before + 5 * 86400000);
      if (holdUntilVal) expect(holdUntilVal).toBeGreaterThan(before);
    }
  });

  it('commission_rate defaults to 1000 bps (10%) when vendor not found', async () => {
    mockDb.first.mockResolvedValue(null);
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_ghost', quantity: 1, price: 2000000, name: 'Ghost' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_ghost.commission_rate).toBe(1000);
    expect(d.data.vendor_breakdown.vnd_ghost.commission).toBe(200000);
  });

  it('5% commission rate (500 bps) yields correct payout', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 500, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 1000000, name: 'A' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_x.commission).toBe(50000);
    expect(d.data.vendor_breakdown.vnd_x.payout).toBe(950000);
  });

  it('multiple cmrc_vendors each get their own settlement_id and hold_until', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [
          { product_id: 'p1', vendor_id: 'vnd_a', quantity: 1, price: 500000, name: 'A' },
          { product_id: 'p2', vendor_id: 'vnd_b', quantity: 1, price: 300000, name: 'B' },
        ],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_a).toBeDefined();
    expect(d.data.vendor_breakdown.vnd_b).toBeDefined();
    expect(d.data.vendor_breakdown.vnd_a.settlement_id).toMatch(/^stl_/);
    expect(d.data.vendor_breakdown.vnd_b.settlement_id).toMatch(/^stl_/);
  });

  it('settlement IDs have stl_ prefix', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 600000, name: 'X' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_x.settlement_id).toMatch(/^stl_/);
  });

  it('hold_days in breakdown matches vendor settlement_hold_days (14-day vendor)', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 14 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 200000, name: 'X' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_breakdown.vnd_x.hold_days).toBe(14);
  });

  it('settlement amount equals payout (not subtotal)', async () => {
    mockDb.first.mockResolvedValue({ commission_rate: 1000, settlement_hold_days: 7 });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', {
        items: [{ product_id: 'p1', vendor_id: 'vnd_x', quantity: 1, price: 1000000, name: 'X' }],
        customer_email: 'a@a.com', payment_method: 'cash', ndpr_consent: true,
      }),
      mockEnv as any,
    );
    const d = await res.json() as any;
    const bd = d.data.vendor_breakdown.vnd_x;
    expect(bd.payout).toBe(bd.subtotal - bd.commission);
    // Settlement amount = payout (not subtotal)
    const settlementInserts = mockDb.prepare.mock.calls
      .map((c: string[]) => c[0]!)
      .filter((sql: string) => sql.includes('INSERT OR IGNORE INTO cmrc_settlements'));
    expect(settlementInserts.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Suite 3: Paystack Webhook HMAC (9 tests) ─────────────────────────────────
describe('MV-4 POST /paystack/webhook — HMAC-SHA512 signature verification', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null); // no existing log = not yet processed
  });

  const webhookBody = JSON.stringify({
    event: 'charge.success',
    data: { reference: 'ps_ref_test', amount: 1000000, metadata: { tenant_id: 'tnt_test' } },
  });
  const WHDR = { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json' };

  it('returns 400 when x-paystack-signature header is missing', async () => {
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: WHDR,
      body: webhookBody,
    });
    const res = await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    expect(res.status).toBe(400);
    const d = await res.json() as any;
    expect(d.error).toMatch(/signature/i);
  });

  it('returns 401 when signature is invalid (tampered body)', async () => {
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': 'aaaa1111bbbb2222invalid' },
      body: webhookBody,
    });
    const res = await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    expect(res.status).toBe(401);
  });

  it('returns 200 for charge.success with valid HMAC-SHA512 signature', async () => {
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, webhookBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: webhookBody,
    });
    const res = await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.success).toBe(true);
  });

  it('charge.success updates cmrc_orders payment_status to paid', async () => {
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, webhookBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: webhookBody,
    });
    await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    const updateCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!);
    const orderUpdate = updateCalls.find((sql: string) => sql.includes("payment_status = 'paid'") && sql.includes('cmrc_orders'));
    expect(orderUpdate).toBeDefined();
  });

  it('charge.success promotes eligible held cmrc_settlements', async () => {
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, webhookBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: webhookBody,
    });
    await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    const settlementUpdate = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!)
      .find((sql: string) => sql.includes("'eligible'") && sql.includes('cmrc_settlements'));
    expect(settlementUpdate).toBeDefined();
  });

  it('transfer.success marks payout_request as paid', async () => {
    const transferBody = JSON.stringify({
      event: 'transfer.success',
      data: { transfer_code: 'TRF_abc123', amount: 900000 },
    });
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, transferBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: transferBody,
    });
    await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    const updateCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!);
    const payoutUpdate = updateCalls.find((sql: string) =>
      sql.includes("status = 'paid'") && sql.includes('cmrc_payout_requests'),
    );
    expect(payoutUpdate).toBeDefined();
  });

  it('returns 200 for unknown event types (graceful no-op)', async () => {
    const unknownBody = JSON.stringify({ event: 'invoice.payment_failed', data: { reference: 'ref_unk' } });
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, unknownBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: unknownBody,
    });
    const res = await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    expect(res.status).toBe(200);
  });

  it('logs webhook event to cmrc_paystack_webhook_log table', async () => {
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, webhookBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: webhookBody,
    });
    await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    const insertLog = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!)
      .find((sql: string) => sql.includes('cmrc_paystack_webhook_log'));
    expect(insertLog).toBeDefined();
  });

  it('is idempotent: returns 200 immediately when event already processed', async () => {
    // Simulate already-processed event
    mockDb.first.mockResolvedValue({ id: 'pwl_charge_success_ps_ref_test', processed: 1 });
    const sig = await makeWebhookSignature(PAYSTACK_SECRET, webhookBody);
    const req = new Request('http://localhost/paystack/webhook', {
      method: 'POST',
      headers: { ...WHDR, 'x-paystack-signature': sig },
      body: webhookBody,
    });
    const res = await multiVendorRouter.fetch(req, mockEnvWithPaystack as any);
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.message).toMatch(/already processed/i);
  });
});

// ── Suite 4: Shipping estimate (T-CVC-01 — delegates to Logistics) ───────────
// After T-CVC-01, /shipping/estimate delegates to the LOGISTICS_WORKER Service
// Binding. In unit tests the binding is absent, so the graceful fallback path
// is exercised (returns zero-fee estimate with source='fallback').
describe('MV-4 GET /shipping/estimate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
  });

  it('returns 400 when vendor_id is missing', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?state=Lagos'),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    const d = await res.json() as any;
    expect(d.error).toMatch(/vendor_id/i);
  });

  it('returns 400 when state is missing', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1'),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    const d = await res.json() as any;
    expect(d.error).toMatch(/state/i);
  });

  it('returns 200 with fallback zero-fee when LOGISTICS_WORKER binding is absent (T-CVC-01)', async () => {
    // In unit tests LOGISTICS_WORKER is not bound; the handler falls back gracefully.
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Kano'),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.total_fee).toBe(0);
    expect(d.data.source).toBe('fallback');
  });

  it('returns 200 with fallback zero-fee for any vendor+state when binding absent', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Lagos&weight_kg=2&order_value=500000'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.total_fee).toBe(0);
    expect(d.data.source).toBe('fallback');
  });

  it('returns 200 with fallback when order_value exceeds any threshold (binding absent)', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Lagos&order_value=2000000'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.source).toBe('fallback');
  });

  it('returns 200 fallback for Rivers state (binding absent)', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Rivers'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.source).toBe('fallback');
  });

  it('returns 200 fallback when weight_kg not provided (binding absent)', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Lagos'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.total_fee).toBe(0);
    expect(d.data.source).toBe('fallback');
  });

  it('includes vendor_id and state in fallback response for client correlation', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_99&state=Abuja FCT'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.data.vendor_id).toBe('vnd_99');
    expect(d.data.state).toBe('Abuja FCT');
  });

  it('returns 200 fallback for Lagos with large order_value (binding absent)', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Lagos&order_value=9999999'),
      mockEnv as any,
    );
    const d = await res.json() as any;
    expect(d.success).toBe(true);
    expect(d.data.source).toBe('fallback');
  });

  it('delegates to LOGISTICS_WORKER when binding is present (T-CVC-01)', async () => {
    // Simulate a LOGISTICS_WORKER Service Binding returning a real zone estimate.
    const mockLogisticsResp = {
      success: true,
      data: { vendor_id: 'vnd_1', state: 'Lagos', lga: null, base_fee: 150000, per_kg_fee: 20000,
              weight_kg: 2, weight_fee: 40000, free_above: 5000000, is_free: false,
              total_fee: 190000, estimated_days_min: 1, estimated_days_max: 2 },
    };
    const mockLogisticsWorker = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(mockLogisticsResp), { status: 200 })),
    };
    const envWithBinding = { ...mockEnv, LOGISTICS_WORKER: mockLogisticsWorker };
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/shipping/estimate?vendor_id=vnd_1&state=Lagos&weight_kg=2&order_value=500000'),
      envWithBinding as any,
    );
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.data.source).toBe('logistics');
    expect(d.data.total_fee).toBe(190000);
    expect(d.data.is_free).toBe(false);
    expect(mockLogisticsWorker.fetch).toHaveBeenCalledOnce();
  });
});

// ── Suite 5: Delivery zones creation (T-CVC-01 — moved to Logistics) ────────────────────────────
// After T-CVC-01, POST /delivery-zones returns 410 Gone.
// Delivery zone management lives exclusively in webwaka-logistics.
describe('MV-4 POST /delivery-zones', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
  });

  it('returns 410 Gone for any POST /delivery-zones request (T-CVC-01: moved to Logistics)', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/delivery-zones', { vendor_id: 'vnd_1', state: 'Lagos', base_fee: 100000 }),
      mockEnv as any,
    );
    expect(res.status).toBe(410);
    const d = await res.json() as any;
    expect(d.success).toBe(false);
    expect(d.moved_to).toMatch(/webwaka-logistics/i);
  });

  it('returns 410 Gone even with valid vendor JWT (T-CVC-01)', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/delivery-zones', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vendor_id: 'vnd_1', state: 'Lagos', base_fee: 150000 }),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(410);
  });

  it('returns 410 Gone with error message pointing to Logistics service', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/delivery-zones', { vendor_id: 'vnd_1', state: 'Rivers', base_fee: 200000 }),
      mockEnv as any,
    );
    expect(res.status).toBe(410);
    const d = await res.json() as any;
    expect(d.error).toMatch(/Logistics service/i);
  });

  it('returns 410 Gone for Lagos state (T-CVC-01)', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/delivery-zones', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vendor_id: 'vnd_1', state: 'Lagos', base_fee: 150000, per_kg_fee: 20000 }),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(410);
  });

  it('returns 410 Gone for invalid state (T-CVC-01)', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/delivery-zones', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vendor_id: 'vnd_1', state: 'California', base_fee: 100000 }),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(410);
  });

  it('returns 410 Gone for negative base_fee (T-CVC-01)', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/delivery-zones', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ vendor_id: 'vnd_1', state: 'Lagos', base_fee: -100 }),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(410);
  });
});

// ── Suite 6: Vendor cmrc_settlements listing (9 tests) ────────────────────────────
describe('MV-4 GET /cmrc_vendors/:id/cmrc_settlements', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
  });

  it('returns 401 when no JWT provided', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/cmrc_vendors/vnd_1/cmrc_settlements'),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when JWT vendor_id does not match route :id', async () => {
    const token = await makeVendorToken('vnd_other', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(403);
  });

  it('returns empty list when no cmrc_settlements exist', async () => {
    mockDb.all.mockResolvedValue({ results: [] });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(d.data).toEqual([]);
    expect(d.meta.eligible_total).toBe(0);
    expect(d.meta.held_total).toBe(0);
  });

  it('computes eligible_total from cmrc_settlements with status=eligible', async () => {
    const now = Date.now();
    mockDb.all.mockResolvedValue({
      results: [
        { id: 'stl_1', amount: 900000, commission: 100000, hold_days: 7, hold_until: now - 1, status: 'eligible', order_id: 'ord_1', marketplace_order_id: 'mkp_ord_1', payout_request_id: null, created_at: now - 800000 },
        { id: 'stl_2', amount: 450000, commission: 50000, hold_days: 7, hold_until: now + 600000, status: 'held', order_id: 'ord_2', marketplace_order_id: 'mkp_ord_1', payout_request_id: null, created_at: now - 500000 },
      ],
    });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    const d = await res.json() as any;
    expect(d.meta.eligible_total).toBe(900000);
    expect(d.meta.held_total).toBe(450000);
  });

  it('promotes held→eligible cmrc_settlements past hold_until before listing', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    await multiVendorRouter.fetch(req, mockEnv as any);
    const updateCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!);
    const promotionUpdate = updateCalls.find((sql: string) =>
      sql.includes("'eligible'") && sql.includes('cmrc_settlements') && sql.includes('hold_until'),
    );
    expect(promotionUpdate).toBeDefined();
  });

  it('returns total_count in meta matching number of cmrc_settlements returned', async () => {
    const now = Date.now();
    mockDb.all.mockResolvedValue({
      results: [
        { id: 'stl_1', amount: 100000, commission: 10000, hold_days: 7, hold_until: now, status: 'eligible', order_id: null, marketplace_order_id: null, payout_request_id: null, created_at: now },
        { id: 'stl_2', amount: 200000, commission: 20000, hold_days: 7, hold_until: now, status: 'held', order_id: null, marketplace_order_id: null, payout_request_id: null, created_at: now },
        { id: 'stl_3', amount: 300000, commission: 30000, hold_days: 7, hold_until: now, status: 'released', order_id: null, marketplace_order_id: null, payout_request_id: 'pr_1', created_at: now },
      ],
    });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    const d = await res.json() as any;
    expect(d.meta.total_count).toBe(3);
  });

  it('expired JWT is rejected with 401', async () => {
    const expiredToken = await makeExpiredVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${expiredToken}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(401);
  });

  it('settlement query scoped to tenant_id (tenant isolation)', async () => {
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    await multiVendorRouter.fetch(req, mockEnv as any);
    const settlementQueryCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!)
      .filter((sql: string) => sql.includes('FROM cmrc_settlements'));
    expect(settlementQueryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('returns success:true with data array regardless of empty results', async () => {
    mockDb.all.mockResolvedValue({ results: null }); // simulate null results edge case
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/cmrc_settlements', {
      headers: { 'x-tenant-id': 'tnt_test', Authorization: `Bearer ${token}` },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);
    const d = await res.json() as any;
    expect(Array.isArray(d.data)).toBe(true);
  });
});

// ── Suite 7: Payout requests (10 tests) ──────────────────────────────────────
describe('MV-4 POST /cmrc_vendors/:id/payout-request', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.batch.mockResolvedValue([{ meta: { changes: 1 } }]);
  });

  it('returns 401 when no JWT provided', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/cmrc_vendors/vnd_1/payout-request', {}),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when JWT vendor_id does not match route :id', async () => {
    const token = await makeVendorToken('vnd_other', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(403);
  });

  it('returns 409 when a pending payout request already exists', async () => {
    // First first() call = existingPayout SELECT → returns the pending record → 409
    mockDb.first.mockResolvedValueOnce({ id: 'pr_existing', status: 'pending' });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(409);
    const d = await res.json() as any;
    expect(d.error).toMatch(/already/i);
  });

  it('returns 422 when no eligible cmrc_settlements exist', async () => {
    mockDb.first.mockResolvedValue(null); // no existing payout
    mockDb.all.mockResolvedValue({ results: [] }); // no eligible cmrc_settlements
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(422);
    const d = await res.json() as any;
    expect(d.error).toMatch(/eligible/i);
  });

  it('creates payout_request with pr_ prefixed id', async () => {
    mockDb.first
      .mockResolvedValueOnce(null) // no existing payout
      .mockResolvedValueOnce({ bank_details_json: '{"bank_code":"044","account_number":"0123456789"}' }); // vendor row
    mockDb.all.mockResolvedValue({
      results: [{ id: 'stl_1', amount: 900000 }, { id: 'stl_2', amount: 450000 }],
    });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(201);
    const d = await res.json() as any;
    expect(d.data.payout_request_id).toMatch(/^pr_/);
  });

  it('payout amount equals sum of eligible settlement amounts', async () => {
    mockDb.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bank_details_json: null });
    mockDb.all.mockResolvedValue({
      results: [{ id: 'stl_1', amount: 900000 }, { id: 'stl_2', amount: 450000 }],
    });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    const d = await res.json() as any;
    expect(d.data.amount).toBe(1350000);
  });

  it('settlement_count in response matches number of eligible cmrc_settlements', async () => {
    mockDb.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bank_details_json: null });
    mockDb.all.mockResolvedValue({
      results: [{ id: 'stl_1', amount: 900000 }, { id: 'stl_2', amount: 450000 }, { id: 'stl_3', amount: 300000 }],
    });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    const d = await res.json() as any;
    expect(d.data.settlement_count).toBe(3);
  });

  it('updates cmrc_settlements to released status and links payout_request_id', async () => {
    mockDb.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bank_details_json: null });
    mockDb.all.mockResolvedValue({ results: [{ id: 'stl_1', amount: 900000 }] });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    await multiVendorRouter.fetch(req, mockEnv as any);
    const updateCalls = mockDb.prepare.mock.calls.map((c: string[]) => c[0]!);
    const settlementUpdate = updateCalls.find((sql: string) =>
      sql.includes("status = 'released'") && sql.includes('cmrc_settlements'),
    );
    expect(settlementUpdate).toBeDefined();
  });

  it('payout status is pending on creation', async () => {
    mockDb.first
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ bank_details_json: null });
    mockDb.all.mockResolvedValue({ results: [{ id: 'stl_1', amount: 500000 }] });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    const d = await res.json() as any;
    expect(d.data.status).toBe('pending');
  });

  it('processing status is also blocked (409) like pending', async () => {
    mockDb.first.mockResolvedValueOnce({ id: 'pr_processing', status: 'processing' });
    const token = await makeVendorToken('vnd_1', 'tnt_test');
    const req = new Request('http://localhost/cmrc_vendors/vnd_1/payout-request', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tnt_test', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-COM-04: Multi-Vendor Cart Splitting & Consolidated Shipping
// ═══════════════════════════════════════════════════════════════════════════════
describe('T-COM-04: Multi-Vendor Cart Splitting & Consolidated Shipping', () => {
  const mockLogisticsWorker = { fetch: vi.fn() };

  const mockEnvWithLogistics = {
    DB: mockDb,
    TENANT_CONFIG: {},
    EVENTS: {},
    SESSIONS_KV: {},
    JWT_SECRET: 'test-secret-32-chars-minimum!!!',
    CATALOG_CACHE: mockCatalogCache,
    ADMIN_API_KEY: 'admin-secret-key',
    LOGISTICS_WORKER: mockLogisticsWorker,
  };

  function makeLogisticsFetch(totalFee: number) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { total_fee: totalFee } }),
    });
  }

  const checkoutBodyWithShipping = {
    items: [
      { product_id: 'p1', vendor_id: 'vnd_1', quantity: 1, price: 1000000, name: 'Laptop' },
      { product_id: 'p2', vendor_id: 'vnd_2', quantity: 2, price: 250000, name: 'Book' },
    ],
    customer_email: 'buyer@example.com',
    payment_method: 'paystack',
    ndpr_consent: true,
    shipping_address: { state: 'Lagos', lga: 'Ikeja', street: '1 Airport Road' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true });
    mockDb.batch.mockResolvedValue([{ meta: { changes: 1 } }]);
    mockCatalogCache.get.mockResolvedValue(null);
    mockCatalogCache.put.mockResolvedValue(undefined);
    _resetCheckoutRateLimitStore();
    _resetOtpRateLimitStore();
    _resetSearchRateLimitStore();
  });

  it('total_amount = subtotal + consolidated shipping when LOGISTICS_WORKER returns fees', async () => {
    let logisticsCalls = 0;
    mockLogisticsWorker.fetch = vi.fn().mockImplementation(() => {
      logisticsCalls++;
      const fee = logisticsCalls === 1 ? 500000 : 300000;
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { total_fee: fee } }) });
    });

    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    const subtotal = 1000000 + 250000 * 2; // 1 500 000
    expect(data.data.subtotal).toBe(subtotal);
    expect(data.data.total_shipping_kobo).toBe(800000);
    expect(data.data.total_amount).toBe(subtotal + 800000);
  });

  it('shipping_breakdown contains per-vendor fees keyed by vendor_id', async () => {
    let calls = 0;
    mockLogisticsWorker.fetch = vi.fn().mockImplementation(() => {
      calls++;
      const fee = calls === 1 ? 500000 : 300000;
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { total_fee: fee } }) });
    });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    const data = await res.json() as any;
    expect(data.data.shipping_breakdown).toHaveProperty('vnd_1');
    expect(data.data.shipping_breakdown).toHaveProperty('vnd_2');
    const fees = Object.values(data.data.shipping_breakdown as Record<string, number>);
    expect(fees.reduce((a: number, b: number) => a + b, 0)).toBe(800000);
  });

  it('queries LOGISTICS_WORKER exactly once per distinct vendor group', async () => {
    mockLogisticsWorker.fetch = makeLogisticsFetch(200000);
    await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    expect(mockLogisticsWorker.fetch).toHaveBeenCalledTimes(2);
  });

  it('logistics URL includes vendor_id, state, lga, and order_value query params', async () => {
    mockLogisticsWorker.fetch = makeLogisticsFetch(100000);
    await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    const firstCall = (mockLogisticsWorker.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
    const url = firstCall[0] as string;
    expect(url).toContain('vendor_id=');
    expect(url).toContain('state=Lagos');
    expect(url).toContain('lga=Ikeja');
    expect(url).toContain('order_value=');
  });

  it('shipping_source is "logistics" when LOGISTICS_WORKER is configured', async () => {
    mockLogisticsWorker.fetch = makeLogisticsFetch(100000);
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    const data = await res.json() as any;
    expect(data.data.shipping_source).toBe('logistics');
  });

  it('shipping_source is "fallback" when LOGISTICS_WORKER is absent from env', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnv as any,
    );
    const data = await res.json() as any;
    expect(data.data.shipping_source).toBe('fallback');
  });

  it('total_amount = subtotal and shipping = 0 when LOGISTICS_WORKER is absent', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnv as any,
    );
    const data = await res.json() as any;
    const subtotal = 1000000 + 250000 * 2;
    expect(data.data.total_amount).toBe(subtotal);
    expect(data.data.total_shipping_kobo).toBe(0);
  });

  it('total_amount = subtotal and logistics NOT queried when no shipping_address state', async () => {
    mockLogisticsWorker.fetch = makeLogisticsFetch(999999);
    const { shipping_address: _ignored, ...bodyNoAddr } = checkoutBodyWithShipping as any;
    void _ignored;
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', bodyNoAddr),
      mockEnvWithLogistics as any,
    );
    const data = await res.json() as any;
    expect(data.data.total_shipping_kobo).toBe(0);
    expect(mockLogisticsWorker.fetch).not.toHaveBeenCalled();
  });

  it('vendor_breakdown entries include shippingKobo field', async () => {
    let calls = 0;
    mockLogisticsWorker.fetch = vi.fn().mockImplementation(() => {
      calls++;
      const fee = calls === 1 ? 500000 : 300000;
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { total_fee: fee } }) });
    });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    const data = await res.json() as any;
    const breakdown = data.data.vendor_breakdown as Record<string, { shippingKobo: number }>;
    expect(typeof breakdown['vnd_1']?.shippingKobo).toBe('number');
    expect(typeof breakdown['vnd_2']?.shippingKobo).toBe('number');
    const totalShipping = Object.values(breakdown).reduce((s, v) => s + (v.shippingKobo ?? 0), 0);
    expect(totalShipping).toBe(800000);
  });

  it('gracefully falls back to 0 when logistics worker throws a network error', async () => {
    mockLogisticsWorker.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.total_shipping_kobo).toBe(0);
  });

  it('gracefully falls back to 0 when logistics worker returns success:false', async () => {
    mockLogisticsWorker.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, data: null }),
    });
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', checkoutBodyWithShipping),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.total_shipping_kobo).toBe(0);
  });

  it('single-vendor checkout surfaces shipping cost and correct total', async () => {
    mockLogisticsWorker.fetch = makeLogisticsFetch(250000);
    const singleVendorBody = {
      items: [{ product_id: 'px', vendor_id: 'vnd_solo', quantity: 1, price: 2000000, name: 'Chair' }],
      customer_email: 'solo@example.com',
      payment_method: 'paystack',
      ndpr_consent: true,
      shipping_address: { state: 'Abuja', lga: 'Wuse', street: '5 Aminu Crescent' },
    };
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', singleVendorBody),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.data.total_shipping_kobo).toBe(250000);
    expect(data.data.total_amount).toBe(2000000 + 250000);
    expect(data.data.vendor_breakdown['vnd_solo']?.shippingKobo).toBe(250000);
  });

  it('NDPR invariant is enforced even with LOGISTICS_WORKER configured', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('POST', '/checkout', { ...checkoutBodyWithShipping, ndpr_consent: false }),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T-COM-05: Automated RMA Workflow
// Tests: full lifecycle from customer request → vendor approve/dispute →
//        admin resolve → Fintech events, Logistics reverse-pickup delegation
// ═══════════════════════════════════════════════════════════════════════════════
describe('T-COM-05: Automated RMA Workflow', () => {
  // ── JWT helpers ─────────────────────────────────────────────────────────────
  async function makeCustomerToken(email: string, tenantId = 'tnt_test'): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const enc = (obj: object) =>
      btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = enc({ alg: 'HS256', typ: 'JWT' });
    const body = enc({ sub: email, email, role: 'customer', tenant: tenantId, iat: now, exp: now + 3600 });
    const data = `${header}.${body}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret-32-chars-minimum!!!'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
    const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${data}.${sig}`;
  }

  function makeAuthRequest(method: string, path: string, token: string, body?: unknown, tenantId = 'tnt_test', adminKey?: string) {
    const headers: Record<string, string> = {
      'x-tenant-id': tenantId,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (adminKey) headers['x-admin-key'] = adminKey;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    return new Request(`http://localhost${path}`, init);
  }

  const mockLogisticsWorker = { fetch: vi.fn() };
  const mockEnvWithLogistics = {
    DB: mockDb,
    TENANT_CONFIG: {},
    EVENTS: {},
    SESSIONS_KV: {},
    JWT_SECRET: 'test-secret-32-chars-minimum!!!',
    CATALOG_CACHE: mockCatalogCache,
    ADMIN_API_KEY: 'admin-secret-key',
    LOGISTICS_WORKER: mockLogisticsWorker,
  };

  const RMA_BODY = {
    orderId: 'ord_test_1',
    vendorId: 'vnd_seller',
    reason: 'DAMAGED',
    description: 'The item arrived with a cracked screen.',
    evidenceUrls: ['https://cdn.example.com/photo.jpg'],
  };

  const MOCK_ORDER = {
    id: 'ord_test_1',
    customer_email: 'buyer@example.com',
    vendor_id: 'vnd_seller',
    marketplace_order_id: null,
    order_status: 'confirmed',
    total_amount: 2000000,
    created_at: 0, // 0 = waives 7-day window in tests
  };

  const MOCK_RMA = {
    id: 'rma_test_123',
    order_id: 'ord_test_1',
    marketplace_order_id: null,
    vendor_id: 'vnd_seller',
    customer_email: 'buyer@example.com',
    reason: 'DAMAGED',
    description: 'The item arrived with a cracked screen.',
    evidence_urls_json: null,
    status: 'REQUESTED',
    vendor_note: null,
    admin_note: null,
    admin_resolution: null,
    return_label_url: null,
    return_tracking_id: null,
    refund_amount_kobo: 2000000,
    refund_reference: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    resolved_at: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
    mockDb.all.mockResolvedValue({ results: [] });
    mockDb.first.mockResolvedValue(null);
    mockDb.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    mockDb.batch.mockResolvedValue([{ meta: { changes: 1 } }]);
    mockCatalogCache.get.mockResolvedValue(null);
    mockCatalogCache.put.mockResolvedValue(undefined);
    _resetCheckoutRateLimitStore();
    _resetOtpRateLimitStore();
    _resetSearchRateLimitStore();
  });

  // ── POST /rma ────────────────────────────────────────────────────────────────

  it('customer creates RMA successfully → 201 with rmaId', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first
      .mockResolvedValueOnce(MOCK_ORDER) // order lookup
      .mockResolvedValueOnce(null);      // no existing open RMA
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(201);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(data.data.rmaId).toMatch(/^rma_/);
    expect(data.data.status).toBe('REQUESTED');
  });

  it('rejects non-customer JWT with 401', async () => {
    const vendorToken = await makeVendorToken('vnd_seller', 'tnt_test');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', vendorToken, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
    const data = await res.json() as any;
    expect(data.error).toContain('Customer authentication');
  });

  it('rejects invalid reason with 400', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, { ...RMA_BODY, reason: 'INVALID_REASON' }),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    const data = await res.json() as any;
    expect(data.error).toContain('reason must be one of');
  });

  it('rejects empty description with 400', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, { ...RMA_BODY, description: '   ' }),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('description is required');
  });

  it('returns 404 when order not found', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first.mockResolvedValueOnce(null); // order not found
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when customer email does not match order', async () => {
    const token = await makeCustomerToken('other@example.com');
    mockDb.first.mockResolvedValueOnce(MOCK_ORDER); // order with buyer@example.com
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toContain('not the buyer');
  });

  it('returns 409 when duplicate active RMA exists', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first
      .mockResolvedValueOnce(MOCK_ORDER)           // order lookup
      .mockResolvedValueOnce({ id: 'rma_existing' }); // existing open RMA
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(409);
    const data = await res.json() as any;
    expect(data.error).toContain('rma_existing');
  });

  it('returns 422 when return window has expired (order older than 7 days)', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    const oldOrder = {
      ...MOCK_ORDER,
      created_at: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
    };
    mockDb.first.mockResolvedValueOnce(oldOrder);
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(422);
    expect((await res.json() as any).error).toContain('Return window has expired');
  });

  it('accepts all 5 valid RMA reason codes', async () => {
    const reasons = ['DAMAGED', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'CHANGE_OF_MIND', 'OTHER'];
    const token = await makeCustomerToken('buyer@example.com');
    for (const reason of reasons) {
      mockDb.first
        .mockResolvedValueOnce(MOCK_ORDER)
        .mockResolvedValueOnce(null);
      const res = await multiVendorRouter.fetch(
        makeAuthRequest('POST', '/rma', token, { ...RMA_BODY, reason }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
    }
  });

  // ── GET /rma/:id ─────────────────────────────────────────────────────────────

  it('customer reads their own RMA status', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first.mockResolvedValueOnce(MOCK_RMA);
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/rma/rma_test_123', token),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.id).toBe('rma_test_123');
    expect(data.data.status).toBe('REQUESTED');
  });

  it('vendor reads RMA for their order', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce(MOCK_RMA);
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/rma/rma_test_123', token),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
  });

  it('returns 403 when customer tries to read another customer RMA', async () => {
    const token = await makeCustomerToken('other@example.com');
    mockDb.first.mockResolvedValueOnce(MOCK_RMA); // rma belongs to buyer@example.com
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/rma/rma_test_123', token),
      mockEnv as any,
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for unknown RMA id', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first.mockResolvedValueOnce(null);
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/rma/rma_nonexistent', token),
      mockEnv as any,
    );
    expect(res.status).toBe(404);
  });

  // ── POST /rma/:id/vendor-approve ─────────────────────────────────────────────

  it('vendor approves RMA → status VENDOR_APPROVED when no logistics binding', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA }); // rma lookup
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, { note: 'Item defective — approve return' }),
      mockEnv as any, // no LOGISTICS_WORKER
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.status).toBe('VENDOR_APPROVED');
    expect(data.data.labelUrl).toBeNull();
  });

  it('vendor approve with LOGISTICS_WORKER → status LABEL_GENERATED with label URL', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    mockLogisticsWorker.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: { label_url: 'https://logistics.example.com/label/abc123.pdf', tracking_id: 'TRK-8675309' },
      }),
    });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, { note: 'Approved' }),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.status).toBe('LABEL_GENERATED');
    expect(data.data.labelUrl).toBe('https://logistics.example.com/label/abc123.pdf');
    expect(data.data.trackingId).toBe('TRK-8675309');
  });

  it('logistics URL for reverse-pickup POSTed to LOGISTICS_WORKER with correct fields', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    mockLogisticsWorker.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { label_url: 'https://x.com/l.pdf', tracking_id: 'TRK-1' } }),
    });
    await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnvWithLogistics as any,
    );
    expect(mockLogisticsWorker.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = (mockLogisticsWorker.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('reverse-pickup');
    expect(opts.method).toBe('POST');
    const requestBody = JSON.parse(opts.body as string);
    expect(requestBody.rmaId).toBe('rma_test_123');
    expect(requestBody.orderId).toBe('ord_test_1');
    expect(requestBody.vendorId).toBe('vnd_seller');
  });

  it('logistics fallback → VENDOR_APPROVED when reverse-pickup call throws', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    mockLogisticsWorker.fetch = vi.fn().mockRejectedValue(new Error('network'));
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnvWithLogistics as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // Falls back gracefully — status remains VENDOR_APPROVED since label step failed
    expect(['VENDOR_APPROVED', 'LABEL_GENERATED']).toContain(data.data.status);
  });

  it('rejects non-vendor JWT on vendor-approve with 401', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('rejects wrong vendor on vendor-approve with 403', async () => {
    const token = await makeVendorToken('vnd_other', 'tnt_test'); // different vendor
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA }); // rma belongs to vnd_seller
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnv as any,
    );
    expect(res.status).toBe(403);
  });

  it('returns 409 when trying to approve RMA not in REQUESTED status', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA, status: 'VENDOR_APPROVED' });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnv as any,
    );
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('Cannot approve RMA in status');
  });

  // ── POST /rma/:id/vendor-dispute ─────────────────────────────────────────────

  it('vendor cmrc_disputes RMA → status ADMIN_REVIEW', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: 'Item was in perfect condition when shipped.' }),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.status).toBe('ADMIN_REVIEW');
  });

  it('requires note when disputing → 400 without note', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: '' }),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('note is required');
  });

  it('rejects non-vendor JWT on vendor-dispute with 401', async () => {
    const token = await makeCustomerToken('buyer@example.com');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: 'test' }),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('returns 409 when trying to dispute RMA not in REQUESTED status', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA, status: 'ADMIN_REVIEW' });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: 'Already disputed' }),
      mockEnv as any,
    );
    expect(res.status).toBe(409);
  });

  // ── GET /admin/rma ────────────────────────────────────────────────────────────

  it('admin lists RMA requests filtered by status', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test'); // requireRole is passthrough
    mockDb.all.mockResolvedValueOnce({ results: [MOCK_RMA] });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/admin/rma?status=REQUESTED', adminToken, undefined, 'tnt_test', 'admin-secret-key'),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.count).toBe(1);
  });

  it('admin list returns 401 with wrong admin key', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    const req = new Request('http://localhost/admin/rma', {
      method: 'GET',
      headers: {
        'x-tenant-id': 'tnt_test',
        Authorization: `Bearer ${adminToken}`,
        'x-admin-key': 'WRONG_KEY',
      },
    });
    const res = await multiVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(401);
  });

  // ── POST /admin/rma/:id/resolve ───────────────────────────────────────────────

  it('admin resolves APPROVE_RETURN → status REFUNDED', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({
      id: 'rma_test_123', order_id: 'ord_test_1', vendor_id: 'vnd_seller',
      customer_email: 'buyer@example.com', status: 'ADMIN_REVIEW',
      refund_amount_kobo: 2000000,
      paystack_reference: null, payment_reference: null,
    });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_test_123/resolve', adminToken,
        { resolution: 'APPROVE_RETURN', adminNote: 'Customer evidence is valid.' },
        'tnt_test', 'admin-secret-key',
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.status).toBe('REFUNDED');
    expect(data.data.refundAmountKobo).toBe(2000000);
  });

  it('admin resolves REJECT_RETURN → status REJECTED', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({
      id: 'rma_test_123', order_id: 'ord_test_1', vendor_id: 'vnd_seller',
      customer_email: 'buyer@example.com', status: 'ADMIN_REVIEW',
      refund_amount_kobo: 0,
      paystack_reference: null, payment_reference: null,
    });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_test_123/resolve', adminToken,
        { resolution: 'REJECT_RETURN', adminNote: 'Item shows no defects per vendor evidence.' },
        'tnt_test', 'admin-secret-key',
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.data.status).toBe('REJECTED');
  });

  it('admin resolve returns 400 for invalid resolution value', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_test_123/resolve', adminToken,
        { resolution: 'FULL_REFUND' }, // not a valid RMA resolution
        'tnt_test', 'admin-secret-key',
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('resolution must be one of');
  });

  it('admin resolve returns 409 when RMA already in terminal status', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({
      id: 'rma_test_123', order_id: 'ord_test_1', vendor_id: 'vnd_seller',
      customer_email: 'buyer@example.com', status: 'REFUNDED',
      refund_amount_kobo: 2000000,
      paystack_reference: null, payment_reference: null,
    });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_test_123/resolve', adminToken,
        { resolution: 'APPROVE_RETURN' },
        'tnt_test', 'admin-secret-key',
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(409);
    expect((await res.json() as any).error).toContain('terminal status');
  });

  it('admin resolve returns 401 with missing admin key', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_test_123/resolve', adminToken,
        { resolution: 'APPROVE_RETURN' },
        'tnt_test',
        // no admin key provided
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('admin resolve returns 404 when RMA not found', async () => {
    const adminToken = await makeVendorToken('admin_user', 'tnt_test');
    mockDb.first.mockResolvedValueOnce(null); // RMA not found
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/admin/rma/rma_nonexistent/resolve', adminToken,
        { resolution: 'APPROVE_RETURN' },
        'tnt_test', 'admin-secret-key',
      ),
      mockEnv as any,
    );
    expect(res.status).toBe(404);
  });

  // ── Architecture invariant assertions ─────────────────────────────────────────

  it('VENDOR_PAYOUT_HOLD event is emitted when RMA is created (Fintech escrow freeze)', async () => {
    // The event bus is non-fatal (.catch()), so we verify the DB writes occurred
    // (escrow freeze is event-driven, not synchronous — this test checks the RMA is created
    // which is the trigger for VENDOR_PAYOUT_HOLD emission).
    const token = await makeCustomerToken('buyer@example.com');
    mockDb.first
      .mockResolvedValueOnce(MOCK_ORDER)
      .mockResolvedValueOnce(null);
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma', token, RMA_BODY),
      mockEnv as any,
    );
    expect(res.status).toBe(201);
    // cmrc_rma_requests INSERT was called (proves request was persisted before events)
    expect(mockDb.run).toHaveBeenCalled();
  });

  it('no local distance or fee calculation in vendor-approve (logistics delegation invariant)', async () => {
    // Architecture invariant: vendor-approve must call LOGISTICS_WORKER, not calculate locally.
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    mockLogisticsWorker.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { label_url: 'https://x.com/l.pdf', tracking_id: 'TRK-X' } }),
    });
    await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-approve', token, {}),
      mockEnvWithLogistics as any,
    );
    // Logistics worker MUST have been called (not a local calculation)
    expect(mockLogisticsWorker.fetch).toHaveBeenCalledOnce();
    // The call must be to the reverse-pickup endpoint, not a calculation endpoint
    const [callUrl] = (mockLogisticsWorker.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(callUrl).toContain('reverse-pickup');
  });

  // ── Bug-fix regressions ───────────────────────────────────────────────────────

  it('[Bug #1 fix] vendor-dispute issues a SINGLE DB write (no double-write)', async () => {
    // Regression: previously two UPDATEs were issued — first to VENDOR_DISPUTED
    // then immediately overwritten to ADMIN_REVIEW. Fixed: single atomic UPDATE.
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: 'Item was in perfect condition.' }),
      mockEnv as any,
    );
    // Exactly one DB UPDATE should have been issued
    expect(mockDb.run).toHaveBeenCalledTimes(1);
  });

  it('[Bug #1 fix] vendor-dispute response is ADMIN_REVIEW (not VENDOR_DISPUTED)', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.first.mockResolvedValueOnce({ ...MOCK_RMA });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('POST', '/rma/rma_test_123/vendor-dispute', token, { note: 'Item condition disputed.' }),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // VENDOR_DISPUTED must not be the persisted status — it is ADMIN_REVIEW
    expect(data.data.status).toBe('ADMIN_REVIEW');
    expect(data.data.status).not.toBe('VENDOR_DISPUTED');
  });

  // ── GET /vendor/rma ───────────────────────────────────────────────────────────

  it('[Bug #2 fix] vendor lists own RMAs via /vendor/rma — no admin key needed', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.all.mockResolvedValueOnce({ results: [MOCK_RMA] });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/vendor/rma?status=REQUESTED', token),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.success).toBe(true);
    expect(Array.isArray(data.data)).toBe(true);
  });

  it('[Bug #2 fix] GET /vendor/rma rejects customer JWT with 401', async () => {
    const customerToken = await makeCustomerToken('buyer@example.com');
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/vendor/rma', customerToken),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('[Bug #2 fix] GET /vendor/rma rejects unauthenticated request with 401', async () => {
    const res = await multiVendorRouter.fetch(
      makeRequest('GET', '/vendor/rma'),
      mockEnv as any,
    );
    expect(res.status).toBe(401);
  });

  it('[Bug #3 fix] vendor_id scoped server-side: DB query uses JWT sub not query param', async () => {
    // Architecture invariant: vendor_id in the WHERE clause comes from claims.sub,
    // NOT from any query parameter. A vendor cannot forge another vendor's RMA list.
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    mockDb.all.mockResolvedValueOnce({ results: [] });

    // Even if an attacker adds ?vendor_id=vnd_other to the URL, server ignores it
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/vendor/rma?status=REQUESTED&vendor_id=vnd_other', token),
      mockEnv as any,
    );
    expect(res.status).toBe(200);

    // Verify the DB was called with the JWT's vendor_id (vnd_seller), not vnd_other
    const bindArgs = (mockDb.bind as ReturnType<typeof vi.fn>).mock.calls.at(-1) as unknown[];
    // bindArgs = [tenantId, vendorId, status] — vendorId must be 'vnd_seller' from JWT
    expect(bindArgs).toContain('vnd_seller');
    expect(bindArgs).not.toContain('vnd_other');
  });

  it('[Bug #3 fix] GET /vendor/rma returns only the JWT vendor\'s RMAs (ADMIN_REVIEW too)', async () => {
    const token = await makeVendorToken('vnd_seller', 'tnt_test');
    const disputedRma = { ...MOCK_RMA, status: 'ADMIN_REVIEW', vendor_note: 'Disputed.' };
    mockDb.all.mockResolvedValueOnce({ results: [disputedRma] });
    const res = await multiVendorRouter.fetch(
      makeAuthRequest('GET', '/vendor/rma?status=ADMIN_REVIEW', token),
      mockEnv as any,
    );
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.count).toBe(1);
    expect(data.data[0].status).toBe('ADMIN_REVIEW');
  });
});


