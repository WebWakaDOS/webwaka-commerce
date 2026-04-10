import { generateForecastNarrativeViaAIPlatform } from './ai-platform-narrative';
/**
 * WebWaka — Inventory Forecasting
 * Implementation Plan §3 Item 14 — Inventory Forecasting
 * Implementation Plan §4 Phase 3 — AI & Automation
 *
 * Predicts when stock will run out using:
 *   1. Simple Moving Average (SMA) — edge-computed, fast, no API cost
 *   2. Weighted Moving Average (WMA) — more weight to recent sales
 *   3. Optional OpenRouter LLM narrative — explains the forecast in plain English
 *
 * Also generates Purchase Order (PO) recommendations when runout < lead_time_days.
 *
 * Invariants: Offline-tolerant, Nigeria-First, Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailySales {
  date: string;   // YYYY-MM-DD
  unitsSold: number;
}

export interface InventoryForecast {
  productId: string;
  productName: string;
  sku: string;
  currentStock: number;
  avgDailySales: number;         // SMA over lookback period
  weightedDailySales: number;    // WMA — more weight to recent days
  estimatedRunoutDays: number;   // based on weightedDailySales
  estimatedRunoutDate: string;   // ISO date string
  reorderPoint: number;          // stock level at which to reorder
  recommendedOrderQty: number;   // units to order
  urgency: 'OK' | 'LOW' | 'CRITICAL' | 'OUT_OF_STOCK';
  narrative?: string;            // AI-generated plain-English summary
}

// ─── Moving average algorithms ────────────────────────────────────────────────

/**
 * Simple Moving Average over the last N days of sales data.
 */
export function computeSMA(sales: DailySales[], days: number): number {
  const window = sales.slice(-days);
  if (!window.length) return 0;
  const total = window.reduce((s, d) => s + d.unitsSold, 0);
  return total / window.length;
}

/**
 * Weighted Moving Average — linearly increasing weights so the most recent
 * day has the highest weight. Captures seasonal trends better than SMA.
 */
export function computeWMA(sales: DailySales[], days: number): number {
  const window = sales.slice(-days);
  if (!window.length) return 0;
  const n = window.length;
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < n; i++) {
    const weight = i + 1; // weight 1 for oldest, n for newest
    weightedSum += (window[i]?.unitsSold ?? 0) * weight;
    weightTotal += weight;
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

/**
 * Determine urgency level based on estimated runout days and reorder point.
 */
export function classifyUrgency(
  currentStock: number,
  estimatedRunoutDays: number,
  leadTimeDays: number,
): InventoryForecast['urgency'] {
  if (currentStock <= 0) return 'OUT_OF_STOCK';
  if (estimatedRunoutDays <= leadTimeDays) return 'CRITICAL';
  if (estimatedRunoutDays <= leadTimeDays * 2) return 'LOW';
  return 'OK';
}

// ─── D1 query helpers ─────────────────────────────────────────────────────────

/**
 * Fetch daily sales for a product from D1 order history.
 * Returns an array of { date, unitsSold } sorted oldest → newest.
 */
export async function fetchDailySales(
  db: D1Database,
  tenantId: string,
  productId: string,
  lookbackDays = 30,
): Promise<DailySales[]> {
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  try {
    // Try order_items table first (pos + storefront cmrc_orders)
    const { results } = await db.prepare(
      `SELECT DATE(o.created_at / 1000, 'unixepoch') AS sale_date,
              SUM(oi.quantity) AS units_sold
       FROM order_items oi
       JOIN cmrc_orders o ON o.id = oi.order_id
       WHERE o.tenant_id = ?
         AND oi.product_id = ?
         AND o.created_at >= ?
         AND o.order_status NOT IN ('CANCELLED', 'FAILED')
       GROUP BY sale_date
       ORDER BY sale_date ASC`
    ).bind(tenantId, productId, since).all<{ sale_date: string; units_sold: number }>();

    return results.map((r) => ({ date: r.sale_date, unitsSold: r.units_sold }));
  } catch {
    // Table may not exist yet — return empty so forecast shows as unknown
    return [];
  }
}

// ─── Core forecast engine ─────────────────────────────────────────────────────

export interface ForecastOptions {
  lookbackDays?: number;
  leadTimeDays?: number;    // Days from order → delivery for reorder calculation
  safetyStockDays?: number; // Buffer stock (days of inventory kept as safety margin)
  aiPlatformUrl?: string;
  aiPlatformToken?: string;
  openRouterApiKey?: string; // Alias for aiPlatformToken (legacy callers)
  withNarrative?: boolean;
}

/**
 * Generate a full inventory forecast for a single product.
 */
export async function forecastProduct(
  db: D1Database,
  tenantId: string,
  product: { id: string; name: string; sku: string; quantity: number; low_stock_threshold?: number | null },
  options: ForecastOptions = {},
): Promise<InventoryForecast> {
  const {
    lookbackDays = 30,
    leadTimeDays = 7,
    safetyStockDays = 3,
    aiPlatformUrl,
    aiPlatformToken: _aiPlatformToken,
    openRouterApiKey,
    withNarrative = false,
  } = options;
  const aiPlatformToken = _aiPlatformToken ?? openRouterApiKey;

  const dailySales = await fetchDailySales(db, tenantId, product.id, lookbackDays);

  const avgDailySales = computeSMA(dailySales, Math.min(lookbackDays, dailySales.length));
  const weightedDailySales = computeWMA(dailySales, Math.min(lookbackDays, dailySales.length));

  const effectiveDailyRate = weightedDailySales || avgDailySales || 0.01; // avoid div/0

  const estimatedRunoutDays =
    product.quantity > 0 ? Math.floor(product.quantity / effectiveDailyRate) : 0;

  const runoutDate = new Date(Date.now() + estimatedRunoutDays * 24 * 60 * 60 * 1000);
  const estimatedRunoutDate = runoutDate.toISOString().split('T')[0]!;

  // Reorder point = demand during lead time + safety stock
  const reorderPoint = Math.ceil(
    effectiveDailyRate * (leadTimeDays + safetyStockDays),
  );

  // Recommended order = 30-day supply + safety stock − current stock (if positive)
  const targetStock = Math.ceil(effectiveDailyRate * (30 + safetyStockDays));
  const recommendedOrderQty = Math.max(0, targetStock - product.quantity);

  const urgency = classifyUrgency(product.quantity, estimatedRunoutDays, leadTimeDays);

  const forecast: InventoryForecast = {
    productId: product.id,
    productName: product.name,
    sku: product.sku,
    currentStock: product.quantity,
    avgDailySales: Math.round(avgDailySales * 100) / 100,
    weightedDailySales: Math.round(weightedDailySales * 100) / 100,
    estimatedRunoutDays,
    estimatedRunoutDate,
    reorderPoint,
    recommendedOrderQty,
    urgency,
  };

  // Optional AI narrative
  if (withNarrative && aiPlatformToken && urgency !== 'OK') {
    try {
      forecast.narrative = await generateForecastNarrativeViaAIPlatform({ AI_PLATFORM_URL: aiPlatformUrl, AI_PLATFORM_TOKEN: aiPlatformToken }, forecast);
    } catch { /* AI enrichment is non-fatal */ }
  }

  return forecast;
}

/**
 * Batch forecast for all cmrc_products approaching reorder point.
 * Returns only cmrc_products with urgency LOW, CRITICAL, or OUT_OF_STOCK.
 */
export async function forecastLowStockProducts(
  db: D1Database,
  tenantId: string,
  options: ForecastOptions = {},
): Promise<InventoryForecast[]> {
  interface ProductRow {
    id: string; name: string; sku: string; quantity: number; low_stock_threshold: number | null;
  }

  let cmrc_products: ProductRow[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, sku, quantity, low_stock_threshold
       FROM cmrc_products
       WHERE tenant_id = ? AND is_active = 1 AND deleted_at IS NULL AND quantity < 100
       ORDER BY quantity ASC LIMIT 50`
    ).bind(tenantId).all<ProductRow>();
    cmrc_products = results;
  } catch {
    return [];
  }

  const forecasts = await Promise.all(
    cmrc_products.map((p) => forecastProduct(db, tenantId, p, options))
  );

  return forecasts
    .filter((f) => f.urgency !== 'OK')
    .sort((a, b) => a.estimatedRunoutDays - b.estimatedRunoutDays);
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const forecastingRouter = new Hono<{ Bindings: Env }>();

forecastingRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/**
 * GET /api/forecasting/low-stock
 * Returns cmrc_products approaching their reorder point with runout estimates.
 * Requires TENANT_ADMIN or SUPER_ADMIN.
 */
forecastingRouter.get(
  '/low-stock',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const withNarrative = c.req.query('with_narrative') === 'true';
    const leadTimeDays = Number(c.req.query('lead_time_days') ?? 7);

    const forecasts = await forecastLowStockProducts(c.env.DB, tenantId, {
      withNarrative,
      leadTimeDays,
      openRouterApiKey: c.env.OPENROUTER_API_KEY,
    });

    return c.json({ success: true, data: { forecasts, count: forecasts.length } });
  }
);

/**
 * GET /api/forecasting/product/:id
 * Forecast for a single product.
 */
forecastingRouter.get(
  '/product/:id',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const productId = c.req.param('id');
    const withNarrative = c.req.query('with_narrative') === 'true';

    interface ProductRow {
      id: string; name: string; sku: string; quantity: number; low_stock_threshold: number | null;
    }

    const product = await c.env.DB.prepare(
      'SELECT id, name, sku, quantity, low_stock_threshold FROM cmrc_products WHERE id = ? AND tenant_id = ?'
    ).bind(productId, tenantId).first<ProductRow>();

    if (!product) return c.json({ success: false, error: 'Product not found' }, 404);

    const forecast = await forecastProduct(c.env.DB, tenantId, product, {
      withNarrative,
      openRouterApiKey: c.env.OPENROUTER_API_KEY,
    });

    return c.json({ success: true, data: forecast });
  }
);
