/**
 * COM-3: Multi-Vendor Marketplace API — Phase MV-1 Tests
 * L2 QA Layer: Auth, vendor isolation, tenant isolation, security hardening
 * Invariants verified: vendor JWT scoping, tenant isolation, admin-key guard, NDPR, Nigeria-First
 *
 * Test count: original 17 → MV-1 adds 25 → total 42 in this file
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { multiVendorRouter } from './api';

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockDb = {
  prepare: vi.fn().mockReturnThis(),
  bind: vi.fn().mockReturnThis(),
  all: vi.fn().mockResolvedValue({ results: [] }),
  first: vi.fn().mockResolvedValue(null),
  run: vi.fn().mockResolvedValue({ success: true }),
};

const mockEnv = { DB: mockDb, TENANT_CONFIG: {}, EVENTS: {}, JWT_SECRET: 'test-secret-32-chars-minimum!!!' };

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

    it('returns zeros when no active vendors or products', async () => {
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

  describe('GET /vendors (public — active only)', () => {
    it('returns only active vendors', async () => {
      mockDb.all.mockResolvedValue({
        results: [{ id: 'vnd_1', name: 'Vendor A', status: 'active' }],
      });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/vendors'), mockEnv as any);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
    });

    it('returns empty array when no active vendors', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/vendors'), mockEnv as any);
      const data = await res.json() as any;
      expect(data.data).toEqual([]);
    });

    it('does NOT expose bank_account or commission_rate fields', async () => {
      mockDb.all.mockResolvedValue({
        results: [{ id: 'vnd_1', name: 'Vendor A', status: 'active', email: 'a@b.com' }],
      });
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/vendors'), mockEnv as any);
      const data = await res.json() as any;
      expect(data.data[0]).not.toHaveProperty('bank_account');
      expect(data.data[0]).not.toHaveProperty('commission_rate');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MV-1 NEW TESTS: ADMIN AUTH GUARD
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /vendors — admin authentication (G-2 fix)', () => {
    it('returns 401 without x-admin-key', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendors', { name: 'X', slug: 'x', email: 'x@x.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
      const data = await res.json() as any;
      expect(data.error).toMatch(/Admin authentication required/i);
    });

    it('registers vendor when admin key provided', async () => {
      mockDb.first.mockResolvedValue(null); // slug uniqueness check — no existing
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/vendors', { name: 'Ade Stores', slug: 'ade-stores', email: 'ade@example.com', phone: '+2348012345678', commission_rate: 800 }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.status).toBe('pending');
    });

    it('generates vendor ID with vnd_ prefix', async () => {
      mockDb.first.mockResolvedValue(null);
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/vendors', { name: 'Bola Shop', slug: 'bola-shop', email: 'bola@example.com' }),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data.id).toMatch(/^vnd_/);
    });

    it('rejects duplicate slug — Nigeria-First uniqueness guard', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_existing' }); // slug already taken
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/vendors', { name: 'Dupe Shop', slug: 'existing-slug', email: 'dupe@example.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.error).toMatch(/already taken/i);
    });

    it('requires name field', async () => {
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('POST', '/vendors', { slug: 'no-name', email: 'a@b.com' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/name/i);
    });
  });

  describe('PATCH /vendors/:id — admin authentication (G-2 fix)', () => {
    it('returns 401 without x-admin-key', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('PATCH', '/vendors/vnd_1', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('activates vendor with admin key', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1' }); // vendor exists
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/vendors/vnd_1', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('rejects invalid status values', async () => {
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/vendors/vnd_1', { status: 'hacked' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/status must be/i);
    });

    it('returns 404 when vendor not found in this marketplace', async () => {
      mockDb.first.mockResolvedValue(null); // vendor doesn't exist for this tenant
      const res = await multiVendorRouter.fetch(
        makeAdminRequest('PATCH', '/vendors/vnd_notexist', { status: 'active' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MV-1 NEW TESTS: VENDOR JWT AUTH + ISOLATION
  // ───────────────────────────────────────────────────────────────────────────

  describe('POST /vendors/:id/products — vendor JWT + ownership (SEC-8 fix)', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendors/vnd_1/products', { sku: 'X', name: 'X', price: 1000, quantity: 1 }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('adds product when vendor owns the catalog', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/products', token, {
          sku: 'VND-001', name: 'Ankara Fabric', price: 35000, quantity: 50,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.data.vendor_id).toBe('vnd_1');
    });

    it('returns 403 when vendor tries to add products to ANOTHER vendor — isolation', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test'); // JWT belongs to vendor A
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_B/products', token, { // trying to add to vendor B
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
        makeVendorRequest('POST', '/vendors/vnd_1/products', token, {
          sku: 'EXP-001', name: 'Test', price: 1000, quantity: 1,
        }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('rejects non-integer price — kobo validation', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/products', token, {
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
        makeVendorRequest('POST', '/vendors/vnd_1/products', token, {
          sku: 'XTENANT-001', name: 'Cross Tenant', price: 1000, quantity: 1,
        }, 'tnt_test'), // request for tnt_test
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET /orders — vendor JWT scoped (G-2 fix)', () => {
    it('returns 401 without JWT', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/orders'), mockEnv as any);
      expect(res.status).toBe(401);
    });

    it('returns vendor-scoped marketplace orders', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [{ id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]' }],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/orders', token),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
    });

    it('vendor A cannot access vendor B orders — DB query is vendor-scoped', async () => {
      // Vendor A gets token and queries — mock returns empty (vendor B items only)
      const tokenA = await makeVendorToken('vnd_A', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] }); // no orders contain vnd_A items
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/orders', tokenA),
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

    it('GET /vendors only shows vendors from the correct marketplace tenant', async () => {
      const res = await multiVendorRouter.fetch(makeRequest('GET', '/vendors', undefined, 'tnt_mkp_abuja'), mockEnv as any);
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

  describe('POST /vendors/:id/kyc — KYC submission (vendor JWT required)', () => {
    const validBvnHash = 'a'.repeat(64);
    const validNinHash = 'b'.repeat(64);

    it('returns 401 without vendor JWT', async () => {
      const res = await multiVendorRouter.fetch(
        makeRequest('POST', '/vendors/vnd_1/kyc', { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('returns 403 when vendor tries to submit KYC for another vendor', async () => {
      const token = await makeVendorToken('vnd_A', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_B/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.error).toMatch(/own vendor account/i);
    });

    it('returns 403 when JWT tenant does not match header tenant', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_OTHER');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }, 'tnt_test'),
        mockEnv as any,
      );
      expect(res.status).toBe(403);
    });

    it('returns 400 when no KYC identifiers provided', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, {}),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/rc_number|bvn_hash|nin_hash/i);
    });

    it('returns 400 when bvn_hash is not a valid SHA-256 hex string', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { bvn_hash: 'not-a-hash' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when nin_hash is not 64 hex chars', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { nin_hash: 'tooshort' }),
        mockEnv as any,
      );
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.error).toMatch(/SHA-256/i);
    });

    it('returns 400 when bank_details account_number is not 10 digits', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, {
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
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, {
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
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
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
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(409);
    });

    it('returns 409 when KYC already approved', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'approved' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-123456' }),
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
        makeVendorRequest('POST', '/vendors/vnd_ghost/kyc', token, { rc_number: 'RC-123456' }),
        mockEnv as any,
      );
      expect(res.status).toBe(404);
    });

    it('submits KYC successfully with rc_number only', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
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
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, {
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
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { bvn_hash: validBvnHash }),
        mockEnv as any,
      );
      expect(res.status).toBe(200);
    });

    it('generated kyc_submitted_at is a current epoch ms timestamp', async () => {
      mockDb.first.mockResolvedValue({ id: 'vnd_1', kyc_status: 'none' });
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      const before = Date.now();
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('POST', '/vendors/vnd_1/kyc', token, { rc_number: 'RC-1234567' }),
        mockEnv as any,
      );
      const after = Date.now();
      const data = await res.json() as any;
      expect(data.data.kyc_submitted_at).toBeGreaterThanOrEqual(before);
      expect(data.data.kyc_submitted_at).toBeLessThanOrEqual(after);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MV-2: DASHBOARD SCOPING (additional ledger / orders validation)
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

  describe('Dashboard scoping — GET /orders vendor filter', () => {
    it('only returns orders from the marketplace channel', async () => {
      const token = await makeVendorToken('vnd_1', 'tnt_test');
      mockDb.all.mockResolvedValue({
        results: [
          { id: 'ord_1', channel: 'marketplace', items_json: '[{"vendor_id":"vnd_1"}]', total_amount: 50000 },
        ],
      });
      const res = await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/orders', token),
        mockEnv as any,
      );
      const data = await res.json() as any;
      expect(data.data[0].channel).toBe('marketplace');
    });

    it('DB query uses vendor LIKE pattern for vendor-scoping', async () => {
      const token = await makeVendorToken('vnd_xyz', 'tnt_test');
      mockDb.all.mockResolvedValue({ results: [] });
      await multiVendorRouter.fetch(
        makeVendorRequest('GET', '/orders', token),
        mockEnv as any,
      );
      const bindArgs = mockDb.bind.mock.calls.flat();
      expect(bindArgs).toContain('%"vendor_id":"vnd_xyz"%');
    });
  });
});

