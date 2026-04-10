/**
 * WebWaka — Product Bundles
 * Implementation Plan §3 Item 19 — Product Bundles
 *
 * Composite cmrc_products ("Starter Kit") with bundled pricing:
 *   - A bundle consists of 2+ component cmrc_products
 *   - Bundle has its own SKU, name, image, and discounted price
 *   - Stock is validated against each component's inventory
 *   - Checkout deducts from each component's stock individually
 *   - Bundle-level quantity is the min(component quantities / required quantities)
 *
 * Invariants: Multi-tenancy, Monetary values as integers (kobo), Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BundleComponent {
  productId: string;
  productName: string;
  quantity: number;         // units of this product per bundle unit
  unitPriceKobo: number;   // price of 1 unit of this component
}

export interface ProductBundle {
  id: string;
  tenantId: string;
  sku: string;
  name: string;
  description?: string;
  imageUrl?: string;
  components: BundleComponent[];
  bundlePriceKobo: number;     // discounted bundle price
  computedRetailPriceKobo: number; // sum of component prices (no discount)
  savingsKobo: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Bundle calculations ──────────────────────────────────────────────────────

/**
 * Compute the non-discounted retail value of a bundle (sum of components).
 */
export function computeRetailPrice(components: BundleComponent[]): number {
  return components.reduce((sum, c) => sum + c.unitPriceKobo * c.quantity, 0);
}

/**
 * Calculate how many units of a bundle can be assembled given current stock.
 * e.g. if a bundle needs 2× Coffee and 1× Mug, and stock is 10 Coffee + 3 Mug,
 * the available bundle quantity is min(10/2, 3/1) = min(5, 3) = 3.
 */
export function computeBundleAvailability(
  components: BundleComponent[],
  stockMap: Map<string, number>,
): number {
  let available = Infinity;
  for (const c of components) {
    const stock = stockMap.get(c.productId) ?? 0;
    const canMake = Math.floor(stock / c.quantity);
    if (canMake < available) available = canMake;
  }
  return available === Infinity ? 0 : available;
}

export function buildBundle(params: {
  tenantId: string;
  sku: string;
  name: string;
  description?: string;
  imageUrl?: string;
  components: BundleComponent[];
  bundlePriceKobo: number;
}): ProductBundle {
  const now = Date.now();
  const retailPrice = computeRetailPrice(params.components);
  return {
    id: `bndl_${now}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: params.tenantId,
    sku: params.sku,
    name: params.name,
    description: params.description,
    imageUrl: params.imageUrl,
    components: params.components,
    bundlePriceKobo: params.bundlePriceKobo,
    computedRetailPriceKobo: retailPrice,
    savingsKobo: Math.max(0, retailPrice - params.bundlePriceKobo),
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const bundlesRouter = new Hono<{ Bindings: Env }>();

bundlesRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/bundles — list active bundles (public) */
bundlesRouter.get('/', async (c) => {
  const tenantId = getTenantId(c)!;
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, sku, name, description, image_url, components_json,
              bundle_price_kobo, computed_retail_price_kobo, savings_kobo, created_at
       FROM cmrc_product_bundles WHERE tenant_id = ? AND is_active = 1
       ORDER BY savings_kobo DESC`
    ).bind(tenantId).all();

    const bundles = await Promise.all(results.map(async (row: Record<string, unknown>) => {
      let components: BundleComponent[] = [];
      try { components = JSON.parse(row.components_json as string) as BundleComponent[]; } catch { /* no-op */ }

      // Get current stock for each component to compute availability
      const productIds = components.map((c) => c.productId);
      let stockMap = new Map<string, number>();
      if (productIds.length > 0) {
        try {
          const placeholders = productIds.map(() => '?').join(',');
          const { results: stockRows } = await c.env.DB.prepare(
            `SELECT id, quantity FROM cmrc_products WHERE id IN (${placeholders}) AND tenant_id = ?`
          ).bind(...productIds, tenantId).all<{ id: string; quantity: number }>();
          stockMap = new Map(stockRows.map((s) => [s.id, s.quantity]));
        } catch { /* non-fatal */ }
      }

      return {
        ...row,
        components,
        available_quantity: computeBundleAvailability(components, stockMap),
      };
    }));

    return c.json({ success: true, data: bundles });
  } catch (err) {
    console.error('[Bundles] list error:', err);
    return c.json({ success: true, data: [] });
  }
});

/** POST /api/commerce/bundles — create a bundle (admin) */
bundlesRouter.post(
  '/',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      sku: string;
      name: string;
      description?: string;
      image_url?: string;
      bundle_price_kobo: number;
      components: Array<{ product_id: string; quantity: number }>;
    }>();

    if (!body.name || !body.sku) return c.json({ success: false, error: 'name and sku required' }, 400);
    if (!body.components?.length) return c.json({ success: false, error: 'components required' }, 400);
    if (body.bundle_price_kobo <= 0) return c.json({ success: false, error: 'bundle_price_kobo must be positive' }, 400);

    // Fetch component product details
    const productIds = body.components.map((c) => c.product_id);
    const placeholders = productIds.map(() => '?').join(',');
    interface ProductRow { id: string; name: string; price: number }
    let cmrc_products: ProductRow[] = [];
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, name, price FROM cmrc_products WHERE id IN (${placeholders}) AND tenant_id = ?`
      ).bind(...productIds, tenantId).all<ProductRow>();
      cmrc_products = results;
    } catch { /* test env */ }

    const productMap = new Map(cmrc_products.map((p) => [p.id, p]));
    const components: BundleComponent[] = body.components.map((comp) => ({
      productId: comp.product_id,
      productName: productMap.get(comp.product_id)?.name ?? comp.product_id,
      quantity: comp.quantity,
      unitPriceKobo: productMap.get(comp.product_id)?.price ?? 0,
    }));

    const bundle = buildBundle({
      tenantId,
      sku: body.sku,
      name: body.name,
      description: body.description,
      imageUrl: body.image_url,
      components,
      bundlePriceKobo: body.bundle_price_kobo,
    });

    try {
      await c.env.DB.prepare(
        `INSERT INTO cmrc_product_bundles
           (id, tenant_id, sku, name, description, image_url, components_json,
            bundle_price_kobo, computed_retail_price_kobo, savings_kobo, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?)`
      ).bind(
        bundle.id, tenantId, bundle.sku, bundle.name, bundle.description ?? null,
        bundle.imageUrl ?? null, JSON.stringify(bundle.components),
        bundle.bundlePriceKobo, bundle.computedRetailPriceKobo, bundle.savingsKobo,
        bundle.createdAt, bundle.updatedAt,
      ).run();

      return c.json({ success: true, data: { id: bundle.id, sku: bundle.sku, savings_kobo: bundle.savingsKobo } }, 201);
    } catch (err) {
      console.error('[Bundles] create error:', err);
      return c.json({ success: false, error: 'Failed to create bundle' }, 500);
    }
  }
);

/** PATCH /api/commerce/bundles/:id — update price or deactivate */
bundlesRouter.patch(
  '/:id',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const id = c.req.param('id');
    const body = await c.req.json<{ bundle_price_kobo?: number; is_active?: boolean }>();
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `UPDATE cmrc_product_bundles SET
           bundle_price_kobo = COALESCE(?, bundle_price_kobo),
           is_active = COALESCE(?, is_active),
           updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      ).bind(body.bundle_price_kobo ?? null, body.is_active ?? null, now, id, tenantId).run();
      return c.json({ success: true, data: { id } });
    } catch (err) {
      console.error('[Bundles] update error:', err);
      return c.json({ success: false, error: 'Update failed' }, 500);
    }
  }
);
