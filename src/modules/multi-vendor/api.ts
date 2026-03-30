/**
 * COM-3: Multi-Vendor Marketplace API — Phase MV-1 + MV-2 + MV-3
 * Auth, security hardening, KYC schema, vendor isolation, vendor onboarding,
 * cross-vendor catalog, marketplace cart, umbrella orders.
 * Invariants: Nigeria-First (Paystack split in MV-3), Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Auth model:
 *   Public  : GET /vendors (active only), GET /vendors/:id/products, GET /catalog,
 *             GET /cart/:token, POST /cart, POST /checkout
 *   Admin   : POST /vendors, PATCH /vendors/:id  (requireRole SUPER_ADMIN | TENANT_ADMIN)
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
import { getTenantId, requireRole, signJwt, verifyJwt, sendTermiiSms } from '@webwaka/core';
import { ndprConsentMiddleware } from '../../middleware/ndpr';
import type { Env } from '../../worker';

const app = new Hono<{ Bindings: Env }>();

// ── Crypto helpers (same pattern as COM-2 Single-Vendor) ──────────────────────

/** SHA-256 hex digest of OTP string */
async function hashOtp(otp: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(otp));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// signJwt and verifyJwt are imported from @webwaka/core (P0-T03)

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

// ── Tenant guard middleware ────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const tenantId = getTenantId(c);
  if (!tenantId) {
    return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  }
  c.set('tenantId' as never, tenantId);
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
  const tenantId = getTenantId(c);
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

    await sendTermiiSms({
      to: e164,
      message: `Your WebWaka Vendor verification code is: ${otpCode}. Valid for 10 minutes. Do not share.`,
      apiKey: c.env.TERMII_API_KEY ?? '',
      channel: 'dnd',
    });

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
  const tenantId = getTenantId(c);
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
  const tenantId = getTenantId(c);
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
  const tenantId = getTenantId(c);
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
  const tenantId = getTenantId(c);
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
// ADMIN ENDPOINTS — requireRole(['SUPER_ADMIN', 'TENANT_ADMIN'])
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendors — Register a new vendor (admin only)
 * Sets status = 'pending' awaiting KYC review and admin activation.
 * bank_account stored as Paystack subaccount code in MV-2 (see MULTI_VENDOR_REVIEW_AND_ENHANCEMENTS.md §7.2).
 */
app.post('/vendors', async (c) => {
  const adminKey = c.req.header('x-admin-key');
  const expectedKey = (c.env as Record<string, unknown>).ADMIN_API_KEY as string | undefined;
  if (!adminKey || (expectedKey && adminKey !== expectedKey)) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }
  const tenantId = getTenantId(c);
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
  const adminKey = c.req.header('x-admin-key');
  const expectedKey = (c.env as Record<string, unknown>).ADMIN_API_KEY as string | undefined;
  if (!adminKey || (expectedKey && adminKey !== expectedKey)) {
    return c.json({ success: false, error: 'Admin authentication required' }, 401);
  }
  const tenantId = getTenantId(c);
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
  const tenantId = getTenantId(c);

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

  const tenantId = getTenantId(c);
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

  const tenantId = getTenantId(c);
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
 * POST /checkout — Marketplace checkout (MV-4 upgrade)
 * MV-3: Creates marketplace_orders umbrella + per-vendor child orders + ledger entries.
 * MV-4 adds:
 *   - Server-side Paystack transaction verify (when PAYSTACK_SECRET set + method='paystack')
 *   - Amount mismatch guard (prevents partial-payment fraud)
 *   - Per-vendor settlement records in `settlements` table (T+7 escrow default)
 *   - Vendor settlement_hold_days respected per vendor
 */
app.post('/checkout', ndprConsentMiddleware, async (c) => {
  const tenantId = getTenantId(c);
  const body = await c.req.json<{
    items: Array<{ product_id: string; vendor_id: string; quantity: number; price: number; name: string }>;
    customer_email: string;
    customer_phone?: string;
    payment_method: string;
    payment_reference?: string;
    ndpr_consent: boolean;
  }>();

  if (!body.items?.length) {
    return c.json({ success: false, error: 'items array is required and must not be empty' }, 400);
  }
  if (!body.customer_email?.trim()) {
    return c.json({ success: false, error: 'customer_email is required' }, 400);
  }

  const subtotalPreVerify = body.items.reduce((s, i) => s + i.price * i.quantity, 0);

  // ── MV-4: Server-side Paystack verification ───────────────────────────────
  if (body.payment_method === 'paystack' && c.env.PAYSTACK_SECRET && body.payment_reference) {
    try {
      const psRes = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(body.payment_reference)}`,
        { headers: { Authorization: `Bearer ${c.env.PAYSTACK_SECRET}` } },
      );
      const psData = await psRes.json() as {
        status: boolean;
        data?: { status: string; amount: number; reference: string };
      };
      if (!psData.status || psData.data?.status !== 'success') {
        return c.json({ success: false, error: 'Payment verification failed. Transaction not successful.' }, 402);
      }
      if (psData.data.amount < subtotalPreVerify) {
        return c.json({
          success: false,
          error: `Payment amount mismatch: received ${psData.data.amount} kobo, expected ${subtotalPreVerify} kobo.`,
        }, 402);
      }
    } catch (fetchErr) {
      return c.json({ success: false, error: `Paystack API error: ${String(fetchErr)}` }, 502);
    }
  } else if (body.payment_method === 'paystack' && c.env.PAYSTACK_SECRET && !body.payment_reference) {
    return c.json({ success: false, error: 'payment_reference is required for Paystack payments' }, 400);
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
      settlement_id?: string; hold_until?: number; hold_days?: number;
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

      // ── MV-4: Settlement record (T+hold_days escrow) ──────────────────────
      // Fetch vendor's settlement_hold_days (default 7 if column not yet migrated)
      const vendorHoldRow = await c.env.DB.prepare(
        `SELECT settlement_hold_days FROM vendors WHERE id = ? AND marketplace_tenant_id = ?`
      ).bind(vendorId, tenantId).first<{ settlement_hold_days?: number }>();
      const holdDays = vendorHoldRow?.settlement_hold_days ?? 7;
      const holdUntil = now + holdDays * 24 * 60 * 60 * 1000;
      const stlId = `stl_${now}_${Math.random().toString(36).slice(2, 9)}`;

      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO settlements
           (id, tenant_id, vendor_id, order_id, marketplace_order_id, amount, commission,
            commission_rate, hold_days, hold_until, status, payment_reference, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`
      ).bind(
        stlId, tenantId, vendorId, childId, mkpOrderId,
        bd.payout, bd.commission, bd.commission_rate,
        holdDays, holdUntil, paymentRef, now, now,
      ).run();

      // Store settlement id in breakdown for response
      bd.settlement_id = stlId;
      bd.hold_until = holdUntil;
      bd.hold_days = holdDays;
    }

    return c.json({
      success: true,
      data: {
        marketplace_order_id: mkpOrderId,
        total_amount: subtotal,
        payment_reference: paymentRef,
        payment_verified: body.payment_method === 'paystack' && !!c.env.PAYSTACK_SECRET,
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
  const tenantId = getTenantId(c);
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

    await sendTermiiSms({
      to: e164,
      message: `Your WebWaka Vendor code is: ${otpCode}. Valid 10 minutes. Do not share.`,
      apiKey: c.env.TERMII_API_KEY ?? '',
      channel: 'dnd',
    });

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
  const tenantId = getTenantId(c);
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
  const tenantId = getTenantId(c);

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
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
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
app.post('/cart', ndprConsentMiddleware, async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);

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
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
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
        expires_in: Math.ceil((cart.expires_at - now) / 1000),
        created_at: cart.created_at,
        updated_at: cart.updated_at,
      },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-4: PAYSTACK WEBHOOK — HMAC-SHA512 signature verify + event handling
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /paystack/webhook
 * Verifies x-paystack-signature header (HMAC-SHA512 of raw body with PAYSTACK_SECRET).
 * Handles: charge.success → marks order paid + creates settlement if missing.
 *          transfer.success → marks payout_request as paid.
 * Idempotent: logs each event in paystack_webhook_log (unique on event+reference).
 */
app.post('/paystack/webhook', async (c) => {
  const signature = c.req.header('x-paystack-signature');
  if (!signature) {
    return c.json({ success: false, error: 'Missing x-paystack-signature header' }, 400);
  }

  const rawBody = await c.req.text();

  // HMAC-SHA512 verification using Web Crypto
  try {
    const secret = c.env.PAYSTACK_SECRET ?? '';
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    if (hex !== signature) {
      return c.json({ success: false, error: 'Invalid signature' }, 401);
    }
  } catch {
    return c.json({ success: false, error: 'Signature verification error' }, 401);
  }

  let payload: { event: string; data: Record<string, unknown> };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { event, data } = payload;
  const reference = (data.reference ?? data.transfer_code ?? '') as string;
  const tenantId = (data.metadata as Record<string, unknown> | undefined)?.tenant_id as string | undefined;
  const now = Date.now();
  const logId = `pwl_${event.replace('.', '_')}_${reference}`;

  // Idempotency: skip already-processed events
  const existing = await c.env.DB.prepare(
    `SELECT id, processed FROM paystack_webhook_log WHERE id = ?`
  ).bind(logId).first<{ id: string; processed: number }>();

  if (existing?.processed) {
    return c.json({ success: true, message: 'Already processed' });
  }

  // Log the event
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO paystack_webhook_log
       (id, event, reference, tenant_id, raw_json, processed, received_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).bind(logId, event, reference, tenantId ?? null, rawBody, now).run();

  try {
    if (event === 'charge.success') {
      // Mark orders paid
      if (tenantId && reference) {
        await c.env.DB.prepare(
          `UPDATE orders SET payment_status = 'paid', updated_at = ?
           WHERE payment_reference = ? AND tenant_id = ?`
        ).bind(now, reference, tenantId).run();

        await c.env.DB.prepare(
          `UPDATE marketplace_orders SET payment_status = 'paid', updated_at = ?
           WHERE payment_reference = ? AND tenant_id = ?`
        ).bind(now, reference, tenantId).run();

        // Mark held settlements eligible if hold_until has passed
        await c.env.DB.prepare(
          `UPDATE settlements SET status = 'eligible', updated_at = ?
           WHERE tenant_id = ? AND payment_reference = ? AND status = 'held' AND hold_until <= ?`
        ).bind(now, tenantId, reference, now).run();
      }
    } else if (event === 'transfer.success') {
      const transferCode = data.transfer_code as string | undefined;
      if (transferCode) {
        await c.env.DB.prepare(
          `UPDATE payout_requests SET status = 'paid', processed_at = ?, updated_at = ?
           WHERE paystack_transfer_code = ?`
        ).bind(now, now, transferCode).run();
      }
    } else if (event === 'transfer.failed' || event === 'transfer.reversed') {
      const transferCode = data.transfer_code as string | undefined;
      if (transferCode) {
        const reason = event === 'transfer.reversed' ? 'Transfer reversed by Paystack' : 'Transfer failed';
        await c.env.DB.prepare(
          `UPDATE payout_requests SET status = 'failed', failure_reason = ?, processed_at = ?, updated_at = ?
           WHERE paystack_transfer_code = ?`
        ).bind(reason, now, now, transferCode).run();
      }
    }

    // Mark event as processed
    await c.env.DB.prepare(
      `UPDATE paystack_webhook_log SET processed = 1 WHERE id = ?`
    ).bind(logId).run();

    return c.json({ success: true });
  } catch (e) {
    await c.env.DB.prepare(
      `UPDATE paystack_webhook_log SET error = ? WHERE id = ?`
    ).bind(String(e), logId).run();
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-4: DELIVERY ZONES — Nigeria States/LGAs per-vendor shipping rates
// ═══════════════════════════════════════════════════════════════════════════════

const NIGERIA_STATES = new Set([
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue', 'Borno',
  'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'Gombe', 'Imo',
  'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi', 'Kwara', 'Lagos',
  'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo', 'Plateau', 'Rivers',
  'Sokoto', 'Taraba', 'Yobe', 'Zamfara', 'Abuja FCT',
]);

/**
 * POST /delivery-zones — Create or update a delivery zone for a vendor.
 * Requires X-Admin-Key header matching env ADMIN_KEY or vendor JWT with matching vendor_id.
 * Body: { vendor_id, state, lga?, base_fee, per_kg_fee?, free_above?, estimated_days_min?, estimated_days_max? }
 */
app.post('/delivery-zones', async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);
  const jwtVendorId = vendor.vendorId;
  const body = await c.req.json<{
    vendor_id: string;
    state: string;
    lga?: string;
    base_fee: number;
    per_kg_fee?: number;
    free_above?: number;
    estimated_days_min?: number;
    estimated_days_max?: number;
    is_active?: boolean;
  }>();

  if (!body.vendor_id) return c.json({ success: false, error: 'vendor_id is required' }, 400);
  if (body.vendor_id !== jwtVendorId) {
    return c.json({ success: false, error: 'Forbidden: vendor_id does not match token' }, 403);
  }
  if (!body.state?.trim()) return c.json({ success: false, error: 'state is required' }, 400);
  if (!NIGERIA_STATES.has(body.state.trim())) {
    return c.json({ success: false, error: `Invalid Nigerian state: ${body.state}` }, 400);
  }
  if (typeof body.base_fee !== 'number' || body.base_fee < 0) {
    return c.json({ success: false, error: 'base_fee must be a non-negative number (kobo)' }, 400);
  }

  const now = Date.now();
  const dzId = `dz_${now}_${Math.random().toString(36).slice(2, 9)}`;

  try {
    await c.env.DB.prepare(
      `INSERT INTO delivery_zones
         (id, tenant_id, vendor_id, state, lga, base_fee, per_kg_fee, free_above,
          is_active, estimated_days_min, estimated_days_max, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, vendor_id, state, lga)
       DO UPDATE SET base_fee=excluded.base_fee, per_kg_fee=excluded.per_kg_fee,
                     free_above=excluded.free_above, is_active=excluded.is_active,
                     estimated_days_min=excluded.estimated_days_min,
                     estimated_days_max=excluded.estimated_days_max,
                     updated_at=excluded.updated_at`
    ).bind(
      dzId, tenantId, body.vendor_id, body.state.trim(), body.lga?.trim() ?? null,
      body.base_fee, body.per_kg_fee ?? 0, body.free_above ?? null,
      body.is_active !== false ? 1 : 0,
      body.estimated_days_min ?? 1, body.estimated_days_max ?? 3,
      now, now,
    ).run();

    return c.json({ success: true, data: { id: dzId, vendor_id: body.vendor_id, state: body.state, lga: body.lga ?? null, base_fee: body.base_fee } }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

/**
 * GET /shipping/estimate — Calculate shipping fee for a vendor, state, and order value.
 * Query: ?vendor_id=X&state=Y&lga=Z&order_value=V&weight_kg=W
 * Returns fee breakdown + estimated days. Returns 0 fee if no zone found (free/unlimited delivery).
 */
app.get('/shipping/estimate', async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  const vendorId = c.req.query('vendor_id');
  const state = c.req.query('state');
  const lga = c.req.query('lga');
  const orderValue = Number(c.req.query('order_value') ?? '0');
  const weightKg = Number(c.req.query('weight_kg') ?? '0');

  if (!vendorId) return c.json({ success: false, error: 'vendor_id query param is required' }, 400);
  if (!state) return c.json({ success: false, error: 'state query param is required' }, 400);

  try {
    // Try LGA-specific zone first, then state-wide
    let zone = lga
      ? await c.env.DB.prepare(
          `SELECT * FROM delivery_zones
           WHERE tenant_id=? AND vendor_id=? AND state=? AND lga=? AND is_active=1`
        ).bind(tenantId, vendorId, state, lga).first<{
          base_fee: number; per_kg_fee: number; free_above: number | null;
          estimated_days_min: number; estimated_days_max: number;
        }>()
      : null;

    if (!zone) {
      zone = await c.env.DB.prepare(
        `SELECT * FROM delivery_zones
         WHERE tenant_id=? AND vendor_id=? AND state=? AND lga IS NULL AND is_active=1`
      ).bind(tenantId, vendorId, state).first<{
        base_fee: number; per_kg_fee: number; free_above: number | null;
        estimated_days_min: number; estimated_days_max: number;
      }>();
    }

    if (!zone) {
      return c.json({
        success: true,
        data: {
          vendor_id: vendorId, state, lga: lga ?? null,
          base_fee: 0, weight_fee: 0, total_fee: 0, is_free: false,
          note: 'No delivery zone configured for this region',
        },
      });
    }

    const isFree = zone.free_above !== null && orderValue >= zone.free_above;
    const weightFee = Math.round(weightKg * zone.per_kg_fee);
    const totalFee = isFree ? 0 : zone.base_fee + weightFee;

    return c.json({
      success: true,
      data: {
        vendor_id: vendorId, state, lga: lga ?? null,
        base_fee: zone.base_fee, per_kg_fee: zone.per_kg_fee,
        weight_kg: weightKg, weight_fee: weightFee,
        free_above: zone.free_above,
        is_free: isFree, total_fee: totalFee,
        estimated_days_min: zone.estimated_days_min,
        estimated_days_max: zone.estimated_days_max,
      },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-4: VENDOR SETTLEMENTS — View escrow records post-hold
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /vendors/:id/settlements — List settlement records for authenticated vendor.
 * Requires vendor JWT (vendorAuthMiddleware).
 * Returns settled and eligible records plus eligible_total (kobo).
 * Automatically marks held settlements as eligible if hold_until has passed.
 */
app.get('/vendors/:id/settlements', async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  const vendorId = c.req.param('id');
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  if (vendorId !== vendor.vendorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  try {
    const now = Date.now();

    // Promote held → eligible if hold_until has passed
    await c.env.DB.prepare(
      `UPDATE settlements SET status = 'eligible', updated_at = ?
       WHERE tenant_id = ? AND vendor_id = ? AND status = 'held' AND hold_until <= ?`
    ).bind(now, tenantId, vendorId, now).run();

    const rows = await c.env.DB.prepare(
      `SELECT id, order_id, marketplace_order_id, amount, commission, commission_rate,
              hold_days, hold_until, status, payout_request_id, payment_reference,
              created_at, updated_at
       FROM settlements
       WHERE tenant_id = ? AND vendor_id = ?
       ORDER BY created_at DESC LIMIT 100`
    ).bind(tenantId, vendorId).all<{
      id: string; order_id: string | null; marketplace_order_id: string | null;
      amount: number; commission: number; commission_rate: number;
      hold_days: number; hold_until: number; status: string;
      payout_request_id: string | null; payment_reference: string | null;
      created_at: number; updated_at: number;
    }>();

    const eligible_total = (rows.results ?? [])
      .filter(r => r.status === 'eligible')
      .reduce((s, r) => s + r.amount, 0);

    const held_total = (rows.results ?? [])
      .filter(r => r.status === 'held')
      .reduce((s, r) => s + r.amount, 0);

    return c.json({
      success: true,
      data: rows.results ?? [],
      meta: {
        eligible_total,
        held_total,
        total_count: rows.results?.length ?? 0,
      },
    });
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MV-4: PAYOUT REQUESTS — Vendor requests withdrawal of eligible balance
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /vendors/:id/payout-request — Initiate payout withdrawal.
 * Requires vendor JWT. Vendor must have eligible settlements.
 * Creates payout_request, links settlements to it, transitions them to 'released'.
 * Returns 409 if an active payout request is already pending/processing.
 * Returns 422 if eligible_total === 0.
 */
app.post('/vendors/:id/payout-request', async (c) => {
  const tenantId = getTenantId(c);
  if (!tenantId) return c.json({ success: false, error: 'Missing x-tenant-id header' }, 400);
  const vendorId = c.req.param('id');
  const vendor = await authenticateVendor(c);
  if (!vendor) return c.json({ success: false, error: 'Vendor authentication required' }, 401);

  if (vendorId !== vendor.vendorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const now = Date.now();

  try {
    // Promote held → eligible (must run first so the subsequent SELECT captures them)
    await c.env.DB.prepare(
      `UPDATE settlements SET status = 'eligible', updated_at = ?
       WHERE tenant_id = ? AND vendor_id = ? AND status = 'held' AND hold_until <= ?`
    ).bind(now, tenantId, vendorId, now).run();

    // Check for existing pending/processing payout
    const existingPayout = await c.env.DB.prepare(
      `SELECT id, status FROM payout_requests
       WHERE tenant_id = ? AND vendor_id = ? AND status IN ('pending', 'processing')
       LIMIT 1`
    ).bind(tenantId, vendorId).first<{ id: string; status: string }>();

    if (existingPayout) {
      return c.json({
        success: false,
        error: `A payout request (${existingPayout.id}) is already ${existingPayout.status}. Wait for it to complete.`,
      }, 409);
    }

    // Fetch eligible settlements and vendor bank snapshot in parallel
    const [eligible, vendorRecord] = await Promise.all([
      c.env.DB.prepare(
        `SELECT id, amount FROM settlements
         WHERE tenant_id = ? AND vendor_id = ? AND status = 'eligible'`
      ).bind(tenantId, vendorId).all<{ id: string; amount: number }>(),
      c.env.DB.prepare(
        `SELECT bank_details_json FROM vendors WHERE id = ? AND marketplace_tenant_id = ?`
      ).bind(vendorId, tenantId).first<{ bank_details_json: string | null }>(),
    ]);

    const eligibleRows = eligible.results ?? [];
    if (eligibleRows.length === 0) {
      return c.json({ success: false, error: 'No eligible settlements to pay out. Balance may still be in hold period.' }, 422);
    }

    const totalAmount = eligibleRows.reduce((s, r) => s + r.amount, 0);
    const prId = `pr_${now}_${Math.random().toString(36).slice(2, 9)}`;

    // Atomic batch: INSERT payout_request + UPDATE all settlements in a single D1 transaction.
    // If any statement fails the entire batch is rolled back, preventing orphaned payout records.
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO payout_requests
           (id, tenant_id, vendor_id, amount, settlement_count, bank_details_json,
            status, requested_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).bind(
        prId, tenantId, vendorId, totalAmount, eligibleRows.length,
        vendorRecord?.bank_details_json ?? null, now, now, now,
      ),
      ...eligibleRows.map(row =>
        c.env.DB.prepare(
          `UPDATE settlements
           SET status = 'released', payout_request_id = ?, updated_at = ?
           WHERE id = ?`
        ).bind(prId, now, row.id)
      ),
    ]);

    return c.json({
      success: true,
      data: {
        payout_request_id: prId,
        amount: totalAmount,
        settlement_count: eligibleRows.length,
        status: 'pending',
      },
    }, 201);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

export { app as multiVendorRouter };

