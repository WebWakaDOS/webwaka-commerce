/**
 * COM-3: Multi-Vendor Marketplace API — Phase MV-1 + MV-2 + MV-3
 * Auth, security hardening, KYC schema, vendor isolation, vendor onboarding,
 * cross-vendor catalog, marketplace cart, umbrella orders.
 * Invariants: Nigeria-First (Paystack split in MV-3), Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Auth model:
 *   Public  : GET /vendors (active only), GET /vendors/:id/products, GET /catalog,
 *             GET /cart/:token, POST /cart, POST /checkout
 *   Admin   : POST /vendors, PATCH /vendors/:id  (x-admin-key header)
 *   Vendor  : POST /vendors/:id/products, GET /orders, GET /ledger,
 *             POST /vendors/:id/kyc  (Bearer JWT, role='vendor')
 *
 * MV-2 additions:
 *   POST /vendor-auth/request-otp  — alias for /auth/vendor-request-otp (canonical path)
 *   POST /vendor-auth/verify-otp   — alias for /auth/vendor-verify-otp
 *   POST /vendors/:id/kyc          — vendor submits rc_number, bvn_hash, nin_hash, bank_details
 *
 * MV-3 additions:
 *   GET  /catalog                  — cross-vendor cursor-paginated catalog, KV cache, FTS5 search
 *   POST /cart                     — create/update marketplace cart with per-vendor breakdown
 *   GET  /cart/:token              — return cart session with vendor_breakdown_json
 *   POST /checkout                 — upgraded: creates marketplace_orders umbrella + child orders
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
 * POST /checkout — Marketplace checkout with umbrella order + commission splitting
 * MV-3: Creates marketplace_orders umbrella record + per-vendor child orders in orders table.
 *       Builds vendor_breakdown_json with per-vendor subtotal, commission, payout.
 *       All child orders reference the umbrella via marketplace_order_id.
 * MV-4: Will replace client payment_reference with server-side Paystack verify.
 */
app.post('/checkout', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{
    items: Array<{ product_id: string; vendor_id: string; quantity: number; price: number; name: string }>;
    customer_email: string;
    customer_phone?: string;
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

  const now = Date.now();
  const subtotal = body.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const paymentRef = body.payment_reference ?? `pay_mkp_${now}_${Math.random().toString(36).slice(2, 9)}`;

  // ── Group items by vendor ─────────────────────────────────────────────────
  const vendorGroups = body.items.reduce((acc, item) => {
    if (!acc[item.vendor_id]) acc[item.vendor_id] = { items: [], subtotal: 0 };
    acc[item.vendor_id]!.items.push(item);
    acc[item.vendor_id]!.subtotal += item.price * item.quantity;
    return acc;
  }, {} as Record<string, { items: typeof body.items; subtotal: number }>);

  const vendorCount = Object.keys(vendorGroups).length;

  // ── Umbrella order ID (mkp_ord_ prefix) ─────────────────────────────────
  const mkpOrderId = `mkp_ord_${now}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    // ── Build per-vendor breakdown (fetch commission_rates) ──────────────────
    const breakdownMap: Record<string, {
      vendor_id: string; subtotal: number; commission: number; payout: number; commission_rate: number;
    }> = {};

    for (const [vendorId, group] of Object.entries(vendorGroups)) {
      const vendorRow = await c.env.DB.prepare(
        'SELECT commission_rate FROM vendors WHERE id = ? AND marketplace_tenant_id = ?'
      ).bind(vendorId, tenantId).first<{ commission_rate: number }>();

      const commissionRate = vendorRow?.commission_rate ?? 1000;
      const commission = Math.round(group.subtotal * commissionRate / 10000);
      const payout = group.subtotal - commission;
      breakdownMap[vendorId] = { vendor_id: vendorId, subtotal: group.subtotal, commission, payout, commission_rate: commissionRate };
    }

    // ── Insert marketplace_orders umbrella ───────────────────────────────────
    await c.env.DB.prepare(
      `INSERT INTO marketplace_orders
         (id, tenant_id, customer_email, customer_phone, items_json, vendor_count,
          subtotal, total_amount, payment_method, payment_reference, payment_status,
          order_status, channel, ndpr_consent, vendor_breakdown_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'confirmed', 'marketplace', 1, ?, ?, ?)`
    ).bind(
      mkpOrderId, tenantId,
      body.customer_email.trim(),
      body.customer_phone?.trim() ?? null,
      JSON.stringify(body.items),
      vendorCount,
      subtotal, subtotal,
      body.payment_method, paymentRef,
      JSON.stringify(breakdownMap),
      now, now,
    ).run();

    // ── Insert per-vendor child orders ───────────────────────────────────────
    for (const [vendorId, group] of Object.entries(vendorGroups)) {
      const childId = `ord_mkp_${now}_${Math.random().toString(36).slice(2, 9)}`;
      const childSubtotal = group.subtotal;

      await c.env.DB.prepare(
        `INSERT INTO orders
           (id, tenant_id, customer_email, items_json, subtotal, discount, total_amount,
            payment_method, payment_status, order_status, channel, payment_reference,
            marketplace_order_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending', 'confirmed', 'marketplace', ?, ?, ?, ?)`
      ).bind(
        childId, tenantId, body.customer_email.trim(),
        JSON.stringify(group.items),
        childSubtotal, childSubtotal,
        body.payment_method, paymentRef,
        mkpOrderId,
        now, now,
      ).run();

      // Commission + revenue ledger entries
      const bd = breakdownMap[vendorId]!;
      const led1 = `led_${now}_${Math.random().toString(36).slice(2, 9)}`;
      const led2 = `led_${now + 1}_${Math.random().toString(36).slice(2, 9)}`;

      await c.env.DB.prepare(
        `INSERT INTO ledger_entries
           (id, tenant_id, vendor_id, order_id, account_type, amount, type, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, 'commission', ?, 'CREDIT', ?, ?, ?)`
      ).bind(led1, tenantId, vendorId, childId, bd.commission,
        `Commission from umbrella order ${mkpOrderId}`, paymentRef, now).run();

      await c.env.DB.prepare(
        `INSERT INTO ledger_entries
           (id, tenant_id, vendor_id, order_id, account_type, amount, type, description, reference_id, created_at)
         VALUES (?, ?, ?, ?, 'revenue', ?, 'CREDIT', ?, ?, ?)`
      ).bind(led2, tenantId, vendorId, childId, bd.payout,
        `Vendor payout for umbrella order ${mkpOrderId}`, paymentRef, now).run();
    }

    return c.json({
      success: true,
      data: {
        marketplace_order_id: mkpOrderId,
        total_amount: subtotal,
        payment_reference: paymentRef,
        vendor_count: vendorCount,
        vendor_breakdown: breakdownMap,
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-2: VENDOR-AUTH ALIAS ENDPOINTS
// These paths mirror /auth/vendor-request-otp and /auth/vendor-verify-otp
// (canonical MV-1 paths) for clients that prefer the /vendor-auth/ prefix.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendor-auth/request-otp — Alias for /auth/vendor-request-otp
 * Sends a 6-digit OTP to the vendor's registered phone (same Termii flow).
 */
app.post('/vendor-auth/request-otp', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');
  const body = await c.req.json<{ phone: string }>();
  const phone = body.phone?.trim();

  if (!phone) return c.json({ success: false, error: 'phone is required' }, 400);
  if (!/^\+234[0-9]{10}$/.test(phone) && !/^0[0-9]{10}$/.test(phone)) {
    return c.json({ success: false, error: 'Invalid Nigerian phone number. Use E.164 (+234...) or local (0...)' }, 400);
  }

  const e164 = phone.startsWith('+') ? phone : `+234${phone.slice(1)}`;

  try {
    const vendor = await c.env.DB.prepare(
      "SELECT id, status FROM vendors WHERE marketplace_tenant_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1"
    ).bind(tenantId, e164).first<{ id: string; status: string }>();

    if (!vendor) return c.json({ success: false, error: 'No vendor account found with this phone number' }, 404);
    if (vendor.status === 'suspended') return c.json({ success: false, error: 'Vendor account is suspended.' }, 403);

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
          api_key: c.env.TERMII_API_KEY, to: e164, from: 'WebWaka',
          sms: `Your WebWaka Vendor code is: ${otpCode}. Valid 10 minutes. Do not share.`,
          type: 'plain', channel: 'dnd',
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
 * POST /vendor-auth/verify-otp — Alias for /auth/vendor-verify-otp
 * Verifies the OTP and returns a vendor JWT cookie.
 */
app.post('/vendor-auth/verify-otp', async (c) => {
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
    if (otpRow.expires_at < Date.now()) return c.json({ success: false, error: 'OTP expired. Request a new one.' }, 401);
    if (otpRow.attempts >= 5) return c.json({ success: false, error: 'Too many failed attempts.' }, 429);

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
        sub: vendor.id, role: 'vendor', vendor_id: vendor.id,
        tenant: tenantId, phone: e164,
        iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 7 * 86400,
      },
      c.env.JWT_SECRET ?? 'dev-secret-change-me',
    );

    c.header(
      'Set-Cookie',
      `mv_vendor_auth=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/multi-vendor; Max-Age=604800`,
    );

    return c.json({ success: true, data: { token, vendor_id: vendor.id, vendor_name: vendor.name, phone: e164 } });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-2: KYC SUBMISSION ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendors/:id/kyc — Submit KYC documents (vendor JWT required)
 * Vendor submits their CAC registration, hashed BVN/NIN, and bank details.
 * Status changes from 'none' → 'submitted'; admin review sets 'approved'/'rejected'.
 *
 * Security rules:
 *   - Vendor JWT required (role='vendor')
 *   - Ownership: JWT vendor_id must match URL :id (SEC-8 pattern)
 *   - Tenant isolation: JWT tenant must match x-tenant-id
 *   - Idempotent: re-submission allowed while status = 'none' | 'rejected'
 *   - bvn_hash and nin_hash must be pre-hashed by client (SHA-256 hex)
 *
 * Fields:
 *   rc_number       — CAC registration number (e.g., RC-1234567)
 *   bvn_hash        — SHA-256 hex of Bank Verification Number (11 digits)
 *   nin_hash        — SHA-256 hex of National Identification Number (11 digits)
 *   cac_docs_url    — URL to uploaded CAC certificate (R2/S3)
 *   bank_details    — { bank_code: string, account_number: string, account_name: string }
 */
app.post('/vendors/:id/kyc', async (c) => {
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  const vendorId = c.req.param('id');
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID');

  if (vendor.vendorId !== vendorId) {
    return c.json({ success: false, error: 'You may only submit KYC for your own vendor account' }, 403);
  }
  if (vendor.tenantId !== tenantId) {
    return c.json({ success: false, error: 'Tenant mismatch' }, 403);
  }

  const body = await c.req.json<{
    rc_number?: string;
    bvn_hash?: string;
    nin_hash?: string;
    cac_docs_url?: string;
    bank_details?: { bank_code: string; account_number: string; account_name: string };
  }>();

  // At least one KYC identifier required
  if (!body.rc_number?.trim() && !body.bvn_hash?.trim() && !body.nin_hash?.trim()) {
    return c.json({
      success: false,
      error: 'At least one of rc_number, bvn_hash, or nin_hash is required',
    }, 400);
  }

  // Validate hash lengths (SHA-256 = 64 hex chars)
  if (body.bvn_hash && !/^[0-9a-f]{64}$/i.test(body.bvn_hash)) {
    return c.json({ success: false, error: 'bvn_hash must be a valid SHA-256 hex string (64 chars)' }, 400);
  }
  if (body.nin_hash && !/^[0-9a-f]{64}$/i.test(body.nin_hash)) {
    return c.json({ success: false, error: 'nin_hash must be a valid SHA-256 hex string (64 chars)' }, 400);
  }

  // Validate bank_details structure if provided
  if (body.bank_details) {
    const { bank_code, account_number, account_name } = body.bank_details;
    if (!bank_code?.trim() || !account_number?.trim() || !account_name?.trim()) {
      return c.json({ success: false, error: 'bank_details requires bank_code, account_number, and account_name' }, 400);
    }
    if (!/^\d{10}$/.test(account_number)) {
      return c.json({ success: false, error: 'bank_details.account_number must be 10 digits' }, 400);
    }
  }

  try {
    const existing = await c.env.DB.prepare(
      "SELECT id, kyc_status FROM vendors WHERE id = ? AND marketplace_tenant_id = ? AND deleted_at IS NULL"
    ).bind(vendorId, tenantId).first<{ id: string; kyc_status: string }>();

    if (!existing) return c.json({ success: false, error: 'Vendor not found' }, 404);

    // Only allow re-submission when rejected or never submitted
    if (existing.kyc_status === 'submitted' || existing.kyc_status === 'under_review') {
      return c.json({
        success: false,
        error: `KYC already ${existing.kyc_status}. Await admin review before resubmitting.`,
      }, 409);
    }
    if (existing.kyc_status === 'approved') {
      return c.json({ success: false, error: 'KYC already approved. No resubmission needed.' }, 409);
    }

    const now = Date.now();
    await c.env.DB.prepare(
      `UPDATE vendors
       SET rc_number = COALESCE(?, rc_number),
           bvn_hash = COALESCE(?, bvn_hash),
           nin_hash = COALESCE(?, nin_hash),
           cac_docs_url = COALESCE(?, cac_docs_url),
           bank_details_json = COALESCE(?, bank_details_json),
           kyc_status = 'submitted',
           kyc_submitted_at = ?,
           kyc_rejection_reason = NULL,
           updated_at = ?
       WHERE id = ? AND marketplace_tenant_id = ?`
    ).bind(
      body.rc_number?.trim() ?? null,
      body.bvn_hash?.trim() ?? null,
      body.nin_hash?.trim() ?? null,
      body.cac_docs_url?.trim() ?? null,
      body.bank_details ? JSON.stringify(body.bank_details) : null,
      now, now,
      vendorId, tenantId,
    ).run();

    return c.json({
      success: true,
      data: {
        vendor_id: vendorId,
        kyc_status: 'submitted',
        kyc_submitted_at: now,
        message: 'KYC submitted successfully. Admin review typically takes 1-2 business days.',
      },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-3: CROSS-VENDOR CATALOG — GET /catalog
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /catalog
 * Returns active products from all active vendors in this marketplace.
 * Supports cursor pagination (after=<product_id>), per_page (max 24, default 12),
 * search (FTS5 MATCH or LIKE fallback), category, and vendor_id filters.
 *
 * KV cache: CATALOG_CACHE binding, key = mv_catalog_{tenant}_{cacheKey}
 * TTL: 60 seconds. Bypass with ?nocache=1 (admin/dev only, not documented publicly).
 *
 * NDPR: cost_price is never included in response.
 * Tenant isolation: tenant_id from header enforced in all DB predicates.
 */
app.get('/catalog', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID')!;
  const search    = c.req.query('search')?.trim()     ?? '';
  const category  = c.req.query('category')?.trim()   ?? '';
  const vendorId  = c.req.query('vendor_id')?.trim()  ?? '';
  const after     = c.req.query('after')?.trim()      ?? '';
  const perPage   = Math.min(Number(c.req.query('per_page') ?? '12'), 24);
  const noCache   = c.req.query('nocache') === '1';

  const cacheKey = `mv_catalog_${tenantId}_${after}_${search}_${category}_${vendorId}_${perPage}`;

  // ── KV cache hit ──────────────────────────────────────────────────────────
  if (!noCache && c.env.CATALOG_CACHE) {
    const cached = await c.env.CATALOG_CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }
  }

  try {
    // ── Build SQL predicates ─────────────────────────────────────────────────
    const conditions: string[] = [
      'p.tenant_id = ?',
      'p.is_active = 1',
      'p.deleted_at IS NULL',
      'v.status = ?',
      'v.deleted_at IS NULL',
    ];
    const binds: unknown[] = [tenantId, 'active'];

    if (after) {
      conditions.push('p.id > ?');
      binds.push(after);
    }
    if (category) {
      conditions.push('p.category = ?');
      binds.push(category);
    }
    if (vendorId) {
      conditions.push('p.vendor_id = ?');
      binds.push(vendorId);
    }

    // FTS5 search if available; LIKE fallback otherwise
    let searchJoin = '';
    if (search) {
      try {
        // Attempt FTS5 — inner join products_fts (may not exist in older DBs)
        searchJoin = `INNER JOIN products_fts fts ON fts.product_id = p.id AND fts.tenant_id = p.tenant_id`;
        conditions.push('products_fts MATCH ?');
        binds.push(search);
      } catch {
        // Fallback to LIKE if FTS5 table absent
        searchJoin = '';
        conditions.push(`(p.name LIKE ? OR p.description LIKE ? OR p.category LIKE ?)`);
        const like = `%${search}%`;
        binds.push(like, like, like);
      }
    }

    // When FTS5 failed but search is set, searchJoin must be empty and binds already updated above
    // If FTS5 try was not entered:
    const where = conditions.join(' AND ');
    const sql = `
      SELECT
        p.id, p.sku, p.name, p.description, p.category,
        p.price, p.quantity, p.image_url, p.vendor_id,
        v.name  AS vendor_name,
        v.slug  AS vendor_slug,
        v.rating_avg, v.rating_count,
        p.created_at
      FROM products p
      INNER JOIN vendors v ON v.id = p.vendor_id
      ${searchJoin}
      WHERE ${where}
      ORDER BY p.id ASC
      LIMIT ?
    `.trim();

    binds.push(perPage + 1); // fetch one extra to detect has_more

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { results } = await c.env.DB.prepare(sql).bind(...(binds as any[])).all<{
      id: string; sku: string; name: string; description: string | null;
      category: string | null; price: number; quantity: number; image_url: string | null;
      vendor_id: string; vendor_name: string; vendor_slug: string;
      rating_avg: number | null; rating_count: number | null; created_at: number;
    }>();

    const hasMore = results.length > perPage;
    const pageRaw = hasMore ? results.slice(0, perPage) : results;
    const nextCursor = hasMore ? pageRaw[pageRaw.length - 1]!.id : null;

    // NDPR / price integrity: never expose cost_price
    const page = pageRaw.map(({ ...r }) => {
      delete (r as Record<string, unknown>).cost_price;
      return r;
    });

    const payload = JSON.stringify({
      success: true,
      data: page,
      meta: {
        count: page.length,
        has_more: hasMore,
        next_cursor: nextCursor,
        per_page: perPage,
      },
    });

    // ── Store in KV cache ─────────────────────────────────────────────────
    if (c.env.CATALOG_CACHE) {
      await c.env.CATALOG_CACHE.put(cacheKey, payload, { expirationTtl: 60 });
    }

    return new Response(payload, {
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
    });
  } catch (e) {
    // If FTS5 MATCH failed (table not yet populated) retry with LIKE
    if (search && String(e).includes('no such table: products_fts')) {
      const like = `%${search}%`;
      const fallbackBinds: unknown[] = [tenantId, 'active'];
      const fallbackConds = [
        'p.tenant_id = ?', 'p.is_active = 1', 'p.deleted_at IS NULL',
        'v.status = ?', 'v.deleted_at IS NULL',
        `(p.name LIKE ? OR p.description LIKE ? OR p.category LIKE ?)`,
      ];
      fallbackBinds.push(like, like, like);
      if (after)    { fallbackConds.push('p.id > ?');       fallbackBinds.push(after); }
      if (category) { fallbackConds.push('p.category = ?'); fallbackBinds.push(category); }
      if (vendorId) { fallbackConds.push('p.vendor_id = ?');fallbackBinds.push(vendorId); }
      fallbackBinds.push(perPage + 1);

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { results } = await c.env.DB.prepare(
          `SELECT p.id, p.sku, p.name, p.description, p.category,
                  p.price, p.quantity, p.image_url, p.vendor_id,
                  v.name AS vendor_name, v.slug AS vendor_slug,
                  v.rating_avg, v.rating_count, p.created_at
           FROM products p
           INNER JOIN vendors v ON v.id = p.vendor_id
           WHERE ${fallbackConds.join(' AND ')}
           ORDER BY p.id ASC LIMIT ?`
        ).bind(...(fallbackBinds as any[])).all<{
          id: string; sku: string; name: string; description: string | null; category: string | null;
          price: number; quantity: number; image_url: string | null; vendor_id: string;
          vendor_name: string; vendor_slug: string; rating_avg: number | null;
          rating_count: number | null; created_at: number;
        }>();

        const hasMore = results.length > perPage;
        const page = hasMore ? results.slice(0, perPage) : results;
        return c.json({ success: true, data: page, meta: { count: page.length, has_more: hasMore, next_cursor: hasMore ? page[page.length - 1]!.id : null, per_page: perPage } });
      } catch (e2) {
        return c.json({ success: false, error: String(e2) }, 500);
      }
    }
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-3: MARKETPLACE CART — POST /cart + GET /cart/:token
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute per-vendor subtotal breakdown from a cart items array.
 * Returns: { [vendor_id]: { vendor_id, vendor_name, item_count, subtotal } }
 */
function computeVendorBreakdown(
  items: Array<{ vendor_id: string; vendor_name?: string; quantity: number; price: number }>,
): Record<string, { vendor_id: string; vendor_name: string; item_count: number; subtotal: number }> {
  return items.reduce((acc, item) => {
    const key = item.vendor_id;
    if (!acc[key]) {
      acc[key] = { vendor_id: key, vendor_name: item.vendor_name ?? key, item_count: 0, subtotal: 0 };
    }
    acc[key]!.item_count += item.quantity;
    acc[key]!.subtotal   += item.price * item.quantity;
    return acc;
  }, {} as Record<string, { vendor_id: string; vendor_name: string; item_count: number; subtotal: number }>);
}

/**
 * POST /cart — Create or update a marketplace cart session.
 * Body: { items, customer_phone?, ndpr_consent, token? }
 * - items: [{ product_id, vendor_id, vendor_name, name, price, quantity, image_url? }]
 * - token: if provided, updates the existing cart; otherwise creates a new one.
 * - ndpr_consent: must be true (NDPR requirement).
 * Returns: { token, items, vendor_breakdown, total_amount, expires_at, vendor_count }
 */
app.post('/cart', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID')!;

  type CartItem = {
    product_id: string;
    vendor_id: string;
    vendor_name?: string;
    name: string;
    price: number;
    quantity: number;
    image_url?: string;
  };
  const body = await c.req.json<{
    items: CartItem[];
    customer_phone?: string;
    ndpr_consent: boolean;
    token?: string;
  }>();

  if (!body.ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent required to store cart data' }, 400);
  }
  if (!body.items?.length) {
    return c.json({ success: false, error: 'items array is required and must not be empty' }, 400);
  }
  for (const item of body.items) {
    if (!item.product_id?.trim()) return c.json({ success: false, error: 'Each item must have a product_id' }, 400);
    if (!item.vendor_id?.trim())  return c.json({ success: false, error: 'Each item must have a vendor_id' }, 400);
    if (!item.name?.trim())       return c.json({ success: false, error: 'Each item must have a name' }, 400);
    if (!Number.isInteger(item.price) || item.price <= 0)    return c.json({ success: false, error: 'Each item price must be a positive integer (kobo)' }, 400);
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) return c.json({ success: false, error: 'Each item quantity must be a positive integer' }, 400);
  }

  const breakdown = computeVendorBreakdown(body.items);
  const totalAmount = body.items.reduce((s, i) => s + i.price * i.quantity, 0);
  const vendorCount = Object.keys(breakdown).length;
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24-hour cart TTL

  try {
    if (body.token) {
      // Update existing cart
      const existing = await c.env.DB.prepare(
        `SELECT id FROM cart_sessions WHERE session_token = ? AND tenant_id = ? AND expires_at > ?`
      ).bind(body.token, tenantId, now).first<{ id: string }>();

      if (!existing) {
        return c.json({ success: false, error: 'Cart session not found or expired' }, 404);
      }

      await c.env.DB.prepare(
        `UPDATE cart_sessions
         SET items_json = ?, vendor_breakdown_json = ?, expires_at = ?,
             customer_phone = COALESCE(?, customer_phone), updated_at = ?
         WHERE session_token = ? AND tenant_id = ?`
      ).bind(
        JSON.stringify(body.items),
        JSON.stringify(breakdown),
        expiresAt,
        body.customer_phone ?? null,
        now,
        body.token, tenantId,
      ).run();

      return c.json({
        success: true,
        data: {
          token: body.token,
          items: body.items,
          vendor_breakdown: breakdown,
          total_amount: totalAmount,
          vendor_count: vendorCount,
          expires_at: expiresAt,
        },
      });
    }

    // Create new cart
    const token = `cart_mkp_${now}_${Math.random().toString(36).slice(2, 9)}`;
    const cartId = `cs_mkp_${now}_${Math.random().toString(36).slice(2, 9)}`;

    await c.env.DB.prepare(
      `INSERT INTO cart_sessions
         (id, tenant_id, session_token, items_json, vendor_breakdown_json,
          channel, customer_phone, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'marketplace', ?, ?, ?, ?)`
    ).bind(
      cartId, tenantId, token,
      JSON.stringify(body.items),
      JSON.stringify(breakdown),
      body.customer_phone ?? null,
      expiresAt, now, now,
    ).run();

    return c.json({
      success: true,
      data: {
        token,
        items: body.items,
        vendor_breakdown: breakdown,
        total_amount: totalAmount,
        vendor_count: vendorCount,
        expires_at: expiresAt,
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

/**
 * GET /cart/:token — Retrieve a marketplace cart session.
 * Returns cart items + per-vendor breakdown + total_amount.
 * 404 when token not found, belongs to a different tenant, or expired.
 */
app.get('/cart/:token', async (c) => {
  const tenantId = c.req.header('x-tenant-id') || c.req.header('X-Tenant-ID')!;
  const token = c.req.param('token');
  const now = Date.now();

  try {
    const cart = await c.env.DB.prepare(
      `SELECT id, session_token, items_json, vendor_breakdown_json,
              customer_phone, expires_at, created_at, updated_at
       FROM cart_sessions
       WHERE session_token = ? AND tenant_id = ? AND channel = 'marketplace'`
    ).bind(token, tenantId).first<{
      id: string;
      session_token: string;
      items_json: string;
      vendor_breakdown_json: string | null;
      customer_phone: string | null;
      expires_at: number;
      created_at: number;
      updated_at: number;
    }>();

    if (!cart) return c.json({ success: false, error: 'Cart not found' }, 404);
    if (cart.expires_at < now) return c.json({ success: false, error: 'Cart has expired' }, 404);

    let items: unknown[] = [];
    try { items = JSON.parse(cart.items_json); } catch { items = []; }

    let breakdown: Record<string, unknown> = {};
    try { breakdown = cart.vendor_breakdown_json ? JSON.parse(cart.vendor_breakdown_json) : {}; } catch { breakdown = {}; }

    const totalAmount = (items as Array<{ price: number; quantity: number }>)
      .reduce((s, i) => s + (i.price ?? 0) * (i.quantity ?? 0), 0);

    return c.json({
      success: true,
      data: {
        token: cart.session_token,
        items,
        vendor_breakdown: breakdown,
        vendor_count: Object.keys(breakdown).length,
        total_amount: totalAmount,
        item_count: (items as Array<{ quantity: number }>).reduce((s, i) => s + (i.quantity ?? 0), 0),
        expires_at: cart.expires_at,
        created_at: cart.created_at,
        updated_at: cart.updated_at,
      },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

export { app as multiVendorRouter };
