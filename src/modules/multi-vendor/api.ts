/**
 * COM-3: Multi-Vendor Marketplace API — Phase MV-1
 * Auth, security hardening, KYC schema, vendor isolation
 * Invariants: Nigeria-First (Paystack split in MV-2), Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Auth model:
 *   Public  : GET /vendors (active only), GET /vendors/:id/products, GET /, POST /checkout
 *   Admin   : POST /vendors, PATCH /vendors/:id  (x-admin-key header)
 *   Vendor  : POST /vendors/:id/products, GET /orders, GET /ledger  (Bearer JWT, role='vendor')
 */
import { Hono } from 'hono';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// ── Crypto helpers (same pattern as COM-2 Single-Vendor) ──────────────────────

/** SHA-256 hex digest of OTP string */
async function hashOtp(otp: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Minimal HS256 JWT sign using Web Crypto — mirrors COM-2 signJwt */
async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const enc = (obj: object) =>
    btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT' });
  const body = enc(payload);
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${data}.${sig}`;
}

/** Verify HS256 JWT and return claims, or null if invalid/expired — mirrors COM-2 verifyJwt */
export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payloadB64, sigB64] = parts as [string, string, string];
  try {
    const data = `${header}.${payloadB64}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    const sigBuf = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify('HMAC', key, sigBuf, new TextEncoder().encode(data));
    if (!valid) return null;
    const claims = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch { return null; }
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

/**
 * Extract and verify vendor JWT from Authorization Bearer header.
 * Returns { vendorId, tenantId, phone } when token is valid and role='vendor'.
 * Returns null if no token or invalid/expired token.
 * NOTE: tenant matching is intentionally left to each endpoint so that
 *       unauthenticated (401) and authenticated-but-wrong-tenant (403) produce
 *       distinct HTTP status codes.
 */
async function authenticateVendor(
  c: { req: { header: (h: string) => string | undefined }; env: { JWT_SECRET?: string } },
): Promise<{ vendorId: string; tenantId: string; phone: string } | null> {
  const auth = c.req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const claims = await verifyJwt(token, c.env.JWT_SECRET ?? 'dev-secret-change-me');
  if (!claims || claims.role !== 'vendor') return null;
  return {
    vendorId: String(claims.vendor_id),
    tenantId: String(claims.tenant),
    phone: String(claims.phone ?? ''),
  };
}

/**
 * Check x-admin-key header.  Returns true when present (non-empty).
 * In production the key is validated against an env var / KV secret.
 * MV-1 uses presence-only check; MV-2 will add HMAC validation.
 */
function isAdminRequest(c: { req: { header: (h: string) => string | undefined } }): boolean {
  const key = c.req.header('x-admin-key');
  return typeof key === 'string' && key.length > 0;
}

// ── Tenant guard middleware ────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  if (!tenantId) {
    return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  }
  await next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR AUTH — OTP-based login (same pattern as COM-2 customer auth)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /auth/vendor-request-otp
 * Sends a 6-digit OTP via Termii SMS to the vendor's registered phone.
 * Vendor must already be registered in the `vendors` table for this marketplace.
 */
app.post('/auth/vendor-request-otp', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{ phone: string }>();

  const phone = body.phone?.trim();
  if (!phone) return c.json({ success: false, error: 'phone is required' }, 400);
  if (!/^\+234[0-9]{10}$/.test(phone) && !/^0[0-9]{10}$/.test(phone)) {
    return c.json({ success: false, error: 'Invalid Nigerian phone number. Use E.164 (+234...) or local (0...)' }, 400);
  }

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;

  try {
    // Verify vendor exists and is active for this marketplace
    const vendor = await c.env.DB.prepare(
      "SELECT id, status FROM vendors WHERE marketplace_tenant_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1"
    ).bind(tenantId, e164).first<{ id: string; status: string }>();

    if (!vendor) {
      return c.json({ success: false, error: 'No vendor account found with this phone number' }, 404);
    }
    if (vendor.status === 'suspended') {
      return c.json({ success: false, error: 'Vendor account is suspended. Contact marketplace support.' }, 403);
    }

    const otpCode = String(Math.floor(Math.random() * 900000) + 100000);
    const otpHash = await hashOtp(otpCode);
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    const otpId = `votp_${now}_${Math.random().toString(36).slice(2, 8)}`;

    await c.env.DB.prepare(
      `INSERT INTO customer_otps (id, tenant_id, phone, otp_hash, is_used, attempts, expires_at, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?)`
    ).bind(otpId, tenantId, e164, otpHash, expiresAt, now).run();

    if (c.env.TERMII_API_KEY) {
      await fetch('https://api.ng.termii.com/api/sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: c.env.TERMII_API_KEY,
          to: e164,
          from: 'WebWaka',
          sms: `Your WebWaka Vendor verification code is: ${otpCode}. Valid for 10 minutes. Do not share.`,
          type: 'plain',
          channel: 'dnd',
        }),
      });
    }

    return c.json({
      success: true,
      data: { message: `OTP sent to ${e164.slice(0, 6)}****${e164.slice(-4)}`, expires_in: 600 },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

/**
 * POST /auth/vendor-verify-otp
 * Verifies the OTP and returns a vendor JWT with claims:
 * { sub: vendor_id, role: 'vendor', vendor_id, tenant, phone, exp }
 * Token is valid for 7 days. Same HMAC-SHA256/JWT_SECRET as COM-2.
 */
app.post('/auth/vendor-verify-otp', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{ phone: string; otp: string }>();

  const phone = body.phone?.trim();
  const otp = body.otp?.trim();
  if (!phone || !otp) return c.json({ success: false, error: 'phone and otp are required' }, 400);
  if (!/^\d{6}$/.test(otp)) return c.json({ success: false, error: 'OTP must be 6 digits' }, 400);

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;

  try {
    interface OtpRow { id: string; otp_hash: string; is_used: number; attempts: number; expires_at: number }
    const otpRow = await c.env.DB.prepare(
      `SELECT id, otp_hash, is_used, attempts, expires_at
       FROM customer_otps
       WHERE tenant_id = ? AND phone = ? AND is_used = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(tenantId, e164).first<OtpRow>();

    if (!otpRow) return c.json({ success: false, error: 'OTP not found or already used' }, 401);
    if (otpRow.expires_at < Date.now()) return c.json({ success: false, error: 'OTP has expired. Request a new one.' }, 401);
    if (otpRow.attempts >= 5) return c.json({ success: false, error: 'Too many failed attempts. Request a new OTP.' }, 429);

    const inputHash = await hashOtp(otp);
    if (inputHash !== otpRow.otp_hash) {
      await c.env.DB.prepare('UPDATE customer_otps SET attempts = attempts + 1 WHERE id = ?').bind(otpRow.id).run();
      return c.json({ success: false, error: 'Incorrect OTP' }, 401);
    }

    await c.env.DB.prepare('UPDATE customer_otps SET is_used = 1 WHERE id = ?').bind(otpRow.id).run();

    const vendor = await c.env.DB.prepare(
      "SELECT id, name, status FROM vendors WHERE marketplace_tenant_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1"
    ).bind(tenantId, e164).first<{ id: string; name: string; status: string }>();

    if (!vendor) return c.json({ success: false, error: 'Vendor account not found' }, 404);
    if (vendor.status === 'suspended') return c.json({ success: false, error: 'Vendor account suspended' }, 403);

    const now = Date.now();
    const token = await signJwt(
      {
        sub: vendor.id,
        role: 'vendor',
        vendor_id: vendor.id,
        tenant: tenantId,
        phone: e164,
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 7 * 86400,
      },
      c.env.JWT_SECRET ?? 'dev-secret-change-me',
    );

    c.header(
      'Set-Cookie',
      `mv_vendor_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/multi-vendor; Max-Age=604800`,
    );

    return c.json({
      success: true,
      data: { token, vendor_id: vendor.id, vendor_name: vendor.name, phone: e164 },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET / — Marketplace overview (public)
 * Returns count of ACTIVE vendors and all live products for this marketplace.
 */
app.get('/', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  try {
    const vendorCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM vendors WHERE marketplace_tenant_id = ? AND status = 'active' AND deleted_at IS NULL"
    ).bind(tenantId).first<{ count: number }>();
    const productCount = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM products p
       INNER JOIN vendors v ON p.vendor_id = v.id
       WHERE p.tenant_id = ? AND p.is_active = 1 AND p.deleted_at IS NULL
         AND v.status = 'active' AND v.deleted_at IS NULL`
    ).bind(tenantId).first<{ count: number }>();
    return c.json({
      success: true,
      data: {
        active_vendors: vendorCount?.count ?? 0,
        total_products: productCount?.count ?? 0,
      },
    });
  } catch {
    return c.json({ success: true, data: { active_vendors: 0, total_products: 0 } });
  }
});

/**
 * GET /vendors — List ACTIVE vendors only (fix G-3)
 * Public endpoint — does NOT expose pending/suspended vendors.
 * Returns safe fields only: no bank_account, no internal commission details.
 */
app.get('/vendors', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, name, slug, email, phone, address, status, created_at, updated_at
       FROM vendors
       WHERE marketplace_tenant_id = ? AND status = 'active' AND deleted_at IS NULL
       ORDER BY name ASC`
    ).bind(tenantId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

/**
 * GET /vendors/:id/products — List vendor's active products (public browsing)
 * Verifies vendor is active before returning its catalog.
 * Does NOT expose cost_price (avoid COM-2 G-SEC-1 regression).
 * MV-3 will add cursor pagination and KV cache.
 */
app.get('/vendors/:id/products', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const vendorId = c.req.param('id');

  try {
    // Guard: vendor must be active and belong to this marketplace
    const vendor = await c.env.DB.prepare(
      "SELECT id, status FROM vendors WHERE id = ? AND marketplace_tenant_id = ? AND deleted_at IS NULL"
    ).bind(vendorId, tenantId).first<{ id: string; status: string }>();

    if (!vendor) return c.json({ success: false, error: 'Vendor not found' }, 404);
    if (vendor.status !== 'active') return c.json({ success: false, error: 'Vendor catalog not available' }, 403);

    const { results } = await c.env.DB.prepare(
      `SELECT id, tenant_id, vendor_id, sku, name, description, category,
              price, quantity, unit, image_url, barcode, has_variants, is_active, created_at, updated_at
       FROM products
       WHERE vendor_id = ? AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL
       ORDER BY name ASC
       LIMIT 100`
    ).bind(vendorId, tenantId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS — require x-admin-key header
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendors — Register a new vendor (admin only)
 * Sets status = 'pending' awaiting KYC review and admin activation.
 * bank_account stored as Paystack subaccount code in MV-2 (see MULTI_VENDOR_REVIEW_AND_ENHANCEMENTS.md §7.2).
 */
app.post('/vendors', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }

  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{
    name: string;
    slug: string;
    email: string;
    phone?: string;
    address?: string;
    bank_account?: string;
    bank_code?: string;
    commission_rate?: number;
  }>();

  if (!body.name?.trim()) return c.json({ success: false, error: 'name is required' }, 400);
  if (!body.slug?.trim()) return c.json({ success: false, error: 'slug is required' }, 400);
  if (!body.email?.trim()) return c.json({ success: false, error: 'email is required' }, 400);

  const id = `vnd_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  try {
    // Guard: slug must be unique per marketplace (G-3 / missing UNIQUE index — enforced here until migration 006)
    const existing = await c.env.DB.prepare(
      "SELECT id FROM vendors WHERE marketplace_tenant_id = ? AND slug = ? AND deleted_at IS NULL"
    ).bind(tenantId, body.slug.trim()).first<{ id: string }>();

    if (existing) return c.json({ success: false, error: `Slug '${body.slug}' is already taken` }, 409);

    await c.env.DB.prepare(
      `INSERT INTO vendors
         (id, marketplace_tenant_id, name, slug, email, phone, address,
          bank_account, bank_code, commission_rate, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    ).bind(
      id, tenantId,
      body.name.trim(), body.slug.trim(), body.email.trim(),
      body.phone ?? null, body.address ?? null,
      body.bank_account ?? null, body.bank_code ?? null,
      body.commission_rate ?? 1000,
      now, now,
    ).run();

    return c.json({ success: true, data: { id, status: 'pending', ...body } }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

/**
 * PATCH /vendors/:id — Update vendor status or commission (admin only)
 * Valid status values: pending, active, suspended.
 * Suspended vendors immediately disappear from public GET /vendors.
 */
app.patch('/vendors/:id', async (c) => {
  if (!isAdminRequest(c)) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }

  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const id = c.req.param('id');
  const body = await c.req.json<{ status?: string; commission_rate?: number }>();

  const validStatuses = ['pending', 'active', 'suspended'];
  if (body.status && !validStatuses.includes(body.status)) {
    return c.json({ success: false, error: `status must be one of: ${validStatuses.join(', ')}` }, 400);
  }

  const now = Date.now();
  try {
    const vendor = await c.env.DB.prepare(
      "SELECT id FROM vendors WHERE id = ? AND marketplace_tenant_id = ? AND deleted_at IS NULL"
    ).bind(id, tenantId).first<{ id: string }>();

    if (!vendor) return c.json({ success: false, error: 'Vendor not found' }, 404);

    await c.env.DB.prepare(
      `UPDATE vendors
       SET status = COALESCE(?, status),
           commission_rate = COALESCE(?, commission_rate),
           updated_at = ?
       WHERE id = ? AND marketplace_tenant_id = ?`
    ).bind(body.status ?? null, body.commission_rate ?? null, now, id, tenantId).run();

    return c.json({ success: true, data: { id, ...body, updated_at: now } });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// VENDOR-AUTHENTICATED ENDPOINTS — require vendor JWT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendors/:id/products — Add product to vendor's catalog (vendor JWT required)
 * SEC-8 fix: verifies URL vendor_id matches the authenticated vendor's JWT claim.
 * Tenant isolation: products inserted with both tenant_id and vendor_id.
 */
app.post('/vendors/:id/products', async (c) => {
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  const vendorId = c.req.param('id');
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');

  // SEC-8: Vendor can only add products to their own catalog
  if (vendor.vendorId !== vendorId) {
    return c.json({ success: false, error: 'You may only add products to your own vendor catalog' }, 403);
  }
  // Tenant cross-check: JWT tenant must match header
  if (vendor.tenantId !== tenantId) {
    return c.json({ success: false, error: 'Tenant mismatch' }, 403);
  }

  const body = await c.req.json<{
    sku: string;
    name: string;
    price: number;
    quantity: number;
    category?: string;
    description?: string;
    image_url?: string;
  }>();

  if (!body.sku?.trim()) return c.json({ success: false, error: 'sku is required' }, 400);
  if (!body.name?.trim()) return c.json({ success: false, error: 'name is required' }, 400);
  if (!Number.isInteger(body.price) || body.price <= 0) {
    return c.json({ success: false, error: 'price must be a positive integer (kobo)' }, 400);
  }
  if (!Number.isInteger(body.quantity) || body.quantity < 0) {
    return c.json({ success: false, error: 'quantity must be a non-negative integer' }, 400);
  }

  const id = `prod_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO products
         (id, tenant_id, vendor_id, sku, name, description, category,
          price, quantity, image_url, is_active, has_variants, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`
    ).bind(
      id, tenantId, vendorId,
      body.sku.trim(), body.name.trim(),
      body.description ?? null, body.category ?? null,
      body.price, body.quantity,
      body.image_url ?? null,
      now, now,
    ).run();

    return c.json({
      success: true,
      data: { id, vendor_id: vendorId, tenant_id: tenantId, ...body },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

/**
 * GET /orders — Vendor's marketplace orders (vendor JWT required)
 * Scoped: returns only orders containing items from the authenticated vendor.
 * NOTE: Uses items_json LIKE pattern (flat model). MV-2 replaces with vendor_orders table.
 * Tenant isolation: orders.tenant_id = marketplace tenant, channel = 'marketplace'.
 */
app.get('/orders', async (c) => {
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  if (vendor.tenantId !== tenantId) {
    return c.json({ success: false, error: 'Tenant mismatch' }, 403);
  }

  try {
    // Filter marketplace orders that contain items from this vendor
    // MV-2 TODO: replace with SELECT from vendor_orders table once umbrella+child model is in place
    const vendorPattern = `%"vendor_id":"${vendor.vendorId}"%`;
    const { results } = await c.env.DB.prepare(
      `SELECT id, tenant_id, customer_email, subtotal, total_amount,
              payment_method, payment_status, order_status, payment_reference,
              items_json, channel, created_at, updated_at
       FROM orders
       WHERE tenant_id = ? AND channel = 'marketplace'
         AND items_json LIKE ?
         AND deleted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 100`
    ).bind(tenantId, vendorPattern).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

/**
 * GET /ledger — Vendor's ledger entries (vendor JWT required)
 * Scoped to vendor_id from JWT — cannot read other vendors' financial data.
 * Tenant isolation: ledger_entries.tenant_id + vendor_id both checked.
 */
app.get('/ledger', async (c) => {
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  if (vendor.tenantId !== tenantId) {
    return c.json({ success: false, error: 'Tenant mismatch' }, 403);
  }

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, tenant_id, vendor_id, order_id, account_type, amount, type, description, reference_id, created_at
       FROM ledger_entries
       WHERE tenant_id = ? AND vendor_id = ?
       ORDER BY created_at DESC
       LIMIT 200`
    ).bind(tenantId, vendor.vendorId).all();
    return c.json({ success: true, data: results });
  } catch {
    return c.json({ success: true, data: [] });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC CHECKOUT — NDPR required; Paystack verify added in MV-2
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /checkout — Marketplace checkout with commission splitting
 * MV-1: NDPR consent gate enforced; payment_reference accepted from client.
 * MV-2: Replace client reference with server-side Paystack verify + umbrella/child orders.
 */
app.post('/checkout', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{
    items: Array<{ product_id: string; vendor_id: string; quantity: number; price: number; name: string }>;
    customer_email: string;
    payment_method: string;
    payment_reference?: string;
    ndpr_consent: boolean;
  }>();

  if (!body.ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent required' }, 400);
  }
  if (!body.items?.length) {
    return c.json({ success: false, error: 'items array is required and must not be empty' }, 400);
  }
  if (!body.customer_email?.trim()) {
    return c.json({ success: false, error: 'customer_email is required' }, 400);
  }

  const id = `ord_mkp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();
  const subtotal = body.items.reduce((s, i) => s + i.price * i.quantity, 0);

  // MV-2 TODO: verify body.payment_reference with Paystack API before proceeding
  const paymentRef = body.payment_reference ?? `pay_mkp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // Group items by vendor for commission ledger
  const vendorGroups = body.items.reduce((acc, item) => {
    if (!acc[item.vendor_id]) acc[item.vendor_id] = { items: [], subtotal: 0 };
    acc[item.vendor_id]!.items.push(item);
    acc[item.vendor_id]!.subtotal += item.price * item.quantity;
    return acc;
  }, {} as Record<string, { items: typeof body.items; subtotal: number }>);

  try {
    await c.env.DB.prepare(
      `INSERT INTO orders
         (id, tenant_id, customer_email, items_json, subtotal, discount, total_amount,
          payment_method, payment_status, order_status, channel, payment_reference, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending', 'confirmed', 'marketplace', ?, ?, ?)`
    ).bind(
      id, tenantId, body.customer_email.trim(),
      JSON.stringify(body.items), subtotal, subtotal,
      body.payment_method, paymentRef, now, now,
    ).run();

    // Commission ledger entries per vendor
    for (const [vendorId, group] of Object.entries(vendorGroups)) {
      const vendorRow = await c.env.DB.prepare(
        'SELECT commission_rate FROM vendors WHERE id = ? AND marketplace_tenant_id = ?'
      ).bind(vendorId, tenantId).first<{ commission_rate: number }>();

      const commissionRate = vendorRow?.commission_rate ?? 1000;
      const commission = Math.round(group.subtotal * commissionRate / 10000);
      const vendorPayout = group.subtotal - commission;

      const led1 = `led_${now}_${Math.random().toString(36).slice(2, 9)}`;
      const led2 = `led_${now + 1}_${Math.random().toString(36).slice(2, 9)}`;

      await c.env.DB.prepare(
        `INSERT INTO ledger_entries
           (id, tenant_id, vendor_id, order_id, account_type, amount, type, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, 'commission', ?, 'CREDIT', ?, ?, ?)`
      ).bind(led1, tenantId, vendorId, id, commission, `Commission from order ${id}`, paymentRef, now).run();

      await c.env.DB.prepare(
        `INSERT INTO ledger_entries
           (id, tenant_id, vendor_id, order_id, account_type, amount, type, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, 'revenue', ?, 'CREDIT', ?, ?, ?)`
      ).bind(led2, tenantId, vendorId, id, vendorPayout, `Vendor payout for order ${id}`, paymentRef, now).run();
    }

    return c.json({
      success: true,
      data: {
        id,
        total_amount: subtotal,
        payment_reference: paymentRef,
        vendor_count: Object.keys(vendorGroups).length,
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

export { app as multiVendorRouter };
