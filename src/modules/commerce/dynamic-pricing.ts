/**
 * WebWaka — Dynamic Pricing
 * Implementation Plan §3 Item 6 — Dynamic Pricing
 *
 * Automatically adjust prices based on:
 *   1. Inventory levels — lower stock → higher price (scarcity pricing)
 *   2. Demand velocity — fast-selling items → price increase
 *   3. Time of day / day of week — peak hour surges
 *   4. Competitor price scraping (optional — via a passed-in price)
 *
 * Rules are configured per tenant and evaluated at read time.
 * The adjusted price is returned alongside the base price so the UI can
 * show "Was ₦X → Now ₦Y".
 *
 * Invariants: Monetary values as integers (kobo), Multi-tenancy, Nigeria-First
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DynamicPricingTrigger =
  | 'LOW_STOCK'          // stock < threshold → price up
  | 'HIGH_DEMAND'        // velocity above threshold → price up
  | 'PEAK_HOUR'          // within configured time windows → price up/down
  | 'SLOW_MOVING'        // velocity below threshold → price down (clearance)
  | 'COMPETITOR_UNDERCUT'; // competitor price below ours → match or slightly undercut

export interface DynamicPricingRule {
  id: string;
  tenantId: string;
  name: string;
  trigger: DynamicPricingTrigger;
  isActive: boolean;
  /** Threshold value (meaning depends on trigger) */
  thresholdValue: number;
  /** Adjustment: positive = price up, negative = price down */
  adjustmentType: 'PERCENTAGE' | 'FIXED_KOBO';
  adjustmentValue: number;
  /** Floor — price cannot go below base × this fraction (e.g. 0.5 = never below 50%) */
  minPriceFloorPct: number;
  /** Ceiling — price cannot go above base × this fraction (e.g. 3.0 = never above 300%) */
  maxPriceCeilingPct: number;
  createdAt: number;
}

export interface DynamicPriceResult {
  productId: string;
  basePriceKobo: number;
  adjustedPriceKobo: number;
  appliedRules: string[];
  priceDeltaKobo: number;
  adjustmentReasonCode: string;
}

// ─── Adjustment computation ───────────────────────────────────────────────────

/**
 * Apply a single dynamic pricing rule and return the adjusted price.
 */
export function applyPricingRule(
  basePriceKobo: number,
  currentPriceKobo: number,
  rule: DynamicPricingRule,
): number {
  let delta = 0;
  if (rule.adjustmentType === 'PERCENTAGE') {
    delta = Math.round(basePriceKobo * (rule.adjustmentValue / 100));
  } else {
    delta = rule.adjustmentValue; // FIXED_KOBO
  }

  const newPrice = currentPriceKobo + delta;

  // Clamp to floor and ceiling
  const floor = Math.round(basePriceKobo * rule.minPriceFloorPct);
  const ceiling = Math.round(basePriceKobo * rule.maxPriceCeilingPct);
  return Math.max(floor, Math.min(ceiling, newPrice));
}

export interface ProductContext {
  productId: string;
  productName: string;
  basePriceKobo: number;
  currentStock: number;
  lowStockThreshold?: number;
  unitsSoldLast24h?: number;
  competitorPriceKobo?: number;
  hourOfDay?: number;  // 0-23 UTC
  dayOfWeek?: number;  // 0=Sun, 6=Sat
}

/**
 * Evaluate all active rules against a product context and return the final price.
 */
export function evaluateDynamicPrice(
  product: ProductContext,
  rules: DynamicPricingRule[],
): DynamicPriceResult {
  let price = product.basePriceKobo;
  const appliedRules: string[] = [];
  const reasonCodes: string[] = [];

  for (const rule of rules) {
    if (!rule.isActive) continue;

    let triggered = false;

    switch (rule.trigger) {
      case 'LOW_STOCK':
        triggered = product.currentStock <= rule.thresholdValue;
        break;
      case 'HIGH_DEMAND':
        triggered = (product.unitsSoldLast24h ?? 0) >= rule.thresholdValue;
        break;
      case 'SLOW_MOVING':
        triggered = (product.unitsSoldLast24h ?? 0) <= rule.thresholdValue && product.currentStock > 0;
        break;
      case 'PEAK_HOUR': {
        const hour = product.hourOfDay ?? new Date().getUTCHours();
        // thresholdValue encodes HHMM: e.g. 1800 = 18:00 start, adjustment covers ±2h window
        const startHour = Math.floor(rule.thresholdValue / 100);
        const endHour = (startHour + 2) % 24;
        triggered = endHour > startHour
          ? (hour >= startHour && hour < endHour)
          : (hour >= startHour || hour < endHour);
        break;
      }
      case 'COMPETITOR_UNDERCUT':
        if (product.competitorPriceKobo !== undefined) {
          triggered = product.competitorPriceKobo < price;
        }
        break;
    }

    if (triggered) {
      const newPrice = applyPricingRule(product.basePriceKobo, price, rule);
      if (newPrice !== price) {
        price = newPrice;
        appliedRules.push(rule.id);
        reasonCodes.push(rule.trigger);
      }
    }
  }

  return {
    productId: product.productId,
    basePriceKobo: product.basePriceKobo,
    adjustedPriceKobo: price,
    appliedRules,
    priceDeltaKobo: price - product.basePriceKobo,
    adjustmentReasonCode: reasonCodes.join('+') || 'NONE',
  };
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const dynamicPricingRouter = new Hono<{ Bindings: Env }>();

dynamicPricingRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/dynamic-pricing/rules */
dynamicPricingRouter.get(
  '/rules',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    try {
      const { results } = await c.env.DB.prepare(
        `SELECT id, name, trigger, threshold_value, adjustment_type, adjustment_value,
                min_price_floor_pct, max_price_ceiling_pct, is_active, created_at
         FROM dynamic_pricing_rules WHERE tenant_id = ? ORDER BY created_at DESC`
      ).bind(tenantId).all();
      return c.json({ success: true, data: results });
    } catch { return c.json({ success: true, data: [] }); }
  }
);

/** POST /api/commerce/dynamic-pricing/rules */
dynamicPricingRouter.post(
  '/rules',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const body = await c.req.json<{
      name: string;
      trigger: DynamicPricingTrigger;
      threshold_value: number;
      adjustment_type: 'PERCENTAGE' | 'FIXED_KOBO';
      adjustment_value: number;
      min_price_floor_pct?: number;
      max_price_ceiling_pct?: number;
    }>();

    const id = `dpr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        `INSERT INTO dynamic_pricing_rules
           (id, tenant_id, name, trigger, threshold_value, adjustment_type, adjustment_value,
            min_price_floor_pct, max_price_ceiling_pct, is_active, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,?)`
      ).bind(
        id, tenantId, body.name, body.trigger, body.threshold_value,
        body.adjustment_type, body.adjustment_value,
        body.min_price_floor_pct ?? 0.5, body.max_price_ceiling_pct ?? 3.0, now,
      ).run();
      return c.json({ success: true, data: { id } }, 201);
    } catch (err) {
      console.error('[DynamicPricing] create rule error:', err);
      return c.json({ success: false, error: 'Failed to create rule' }, 500);
    }
  }
);

/** POST /api/commerce/dynamic-pricing/evaluate — evaluate price for a product */
dynamicPricingRouter.post('/evaluate', async (c) => {
  const tenantId = getTenantId(c)!;
  const body = await c.req.json<{
    product_id: string;
    competitor_price_kobo?: number;
  }>();

  if (!body.product_id) return c.json({ success: false, error: 'product_id required' }, 400);

  try {
    interface ProductRow {
      id: string; name: string; price: number; quantity: number; low_stock_threshold: number | null;
    }
    const product = await c.env.DB.prepare(
      'SELECT id, name, price, quantity, low_stock_threshold FROM products WHERE id = ? AND tenant_id = ?'
    ).bind(body.product_id, tenantId).first<ProductRow>();

    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);

    // Fetch rules
    const { results: rules } = await c.env.DB.prepare(
      `SELECT id, trigger, threshold_value, adjustment_type, adjustment_value,
              min_price_floor_pct, max_price_ceiling_pct, is_active
       FROM dynamic_pricing_rules WHERE tenant_id = ? AND is_active = 1`
    ).bind(tenantId).all<DynamicPricingRule>();

    // Fetch 24h sales velocity
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const salesRow = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(oi.quantity), 0) as units_sold
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ? AND oi.product_id = ? AND o.created_at >= ?
         AND o.order_status NOT IN ('CANCELLED', 'FAILED')`
    ).bind(tenantId, body.product_id, since24h).first<{ units_sold: number }>();

    const context: ProductContext = {
      productId: product.id,
      productName: product.name,
      basePriceKobo: product.price,
      currentStock: product.quantity,
      lowStockThreshold: product.low_stock_threshold ?? 10,
      unitsSoldLast24h: salesRow?.units_sold ?? 0,
      competitorPriceKobo: body.competitor_price_kobo,
      hourOfDay: new Date().getUTCHours(),
      dayOfWeek: new Date().getUTCDay(),
    };

    const result = evaluateDynamicPrice(context, rules);
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('[DynamicPricing] evaluate error:', err);
    return c.json({ success: false, error: 'Evaluation failed' }, 500);
  }
});
