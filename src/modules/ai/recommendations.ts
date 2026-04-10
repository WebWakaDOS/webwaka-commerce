/**
 * WebWaka — AI Product Recommendations
 * Implementation Plan §3 Item 5 — AI Product Recommendations
 *
 * "Frequently Bought Together" engine using two approaches:
 *   1. Local co-occurrence matrix (edge-computed, zero latency, no API cost)
 *   2. webwaka-ai-platform enrichment (optional) — generates recommendation copy
 *
 * DO NOT call OpenRouter or any LLM provider directly — use ai-platform-narrative.ts
 */

import { generateRecommendationCopyViaAIPlatform, type AIPlatformNarrativeEnv } from './ai-platform-narrative';

export interface RecommendedProduct {
  productId: string;
  productName: string;
  price: number;
  imageUrl?: string;
  sku: string;
  coOccurrenceScore: number;
  reason?: string;
}

export interface CoOccurrenceEntry {
  productA: string;
  productB: string;
  count: number;
}

export async function computeCoOccurrenceMatrix(
  db: D1Database,
  tenantId: string,
  lookbackDays = 90,
  limit = 200,
): Promise<CoOccurrenceEntry[]> {
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  try {
    const { results } = await db.prepare(
      `SELECT oi1.product_id AS product_a,
              oi2.product_id AS product_b,
              COUNT(*) AS co_count
       FROM order_items oi1
       JOIN order_items oi2
         ON oi1.order_id = oi2.order_id
         AND oi1.product_id < oi2.product_id
       JOIN cmrc_orders o ON o.id = oi1.order_id
       WHERE o.tenant_id = ?
         AND o.created_at >= ?
         AND o.order_status NOT IN ('CANCELLED', 'FAILED')
       GROUP BY oi1.product_id, oi2.product_id
       ORDER BY co_count DESC
       LIMIT ?`
    ).bind(tenantId, since, limit).all<{ product_a: string; product_b: string; co_count: number }>();
    return results.map((r) => ({ productA: r.product_a, productB: r.product_b, count: r.co_count }));
  } catch {
    return [];
  }
}

export function getFrequentlyBoughtTogether(
  matrix: CoOccurrenceEntry[],
  seedIds: string[],
  exclude: string[] = [],
  topN = 5,
): Array<{ productId: string; score: number }> {
  const seedSet = new Set(seedIds);
  const excludeSet = new Set([...seedIds, ...exclude]);
  const scoreMap = new Map<string, number>();
  for (const entry of matrix) {
    const { productA, productB, count } = entry;
    if (seedSet.has(productA) && !excludeSet.has(productB))
      scoreMap.set(productB, (scoreMap.get(productB) ?? 0) + count);
    if (seedSet.has(productB) && !excludeSet.has(productA))
      scoreMap.set(productA, (scoreMap.get(productA) ?? 0) + count);
  }
  return Array.from(scoreMap.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([productId, score]) => ({ productId, score }));
}

export async function getRecommendations(
  db: D1Database,
  tenantId: string,
  seedProductIds: string[],
  options: {
    aiPlatformEnv?: AIPlatformNarrativeEnv;
    topN?: number;
    excludeIds?: string[];
    withAiCopy?: boolean;
  } = {},
): Promise<RecommendedProduct[]> {
  if (!seedProductIds.length) return [];
  const { topN = 5, excludeIds = [], withAiCopy = false, aiPlatformEnv } = options;

  const matrix = await computeCoOccurrenceMatrix(db, tenantId);
  const ranked = getFrequentlyBoughtTogether(matrix, seedProductIds, excludeIds, topN * 2);
  if (!ranked.length) return [];

  const productIds = ranked.map((r) => r.productId);
  const placeholders = productIds.map(() => '?').join(',');
  interface ProductRow { id: string; name: string; price: number; image_url: string | null; sku: string }
  let cmrc_products: ProductRow[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, price, image_url, sku FROM cmrc_products
       WHERE id IN (${placeholders}) AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL`
    ).bind(...productIds, tenantId).all<ProductRow>();
    cmrc_products = results;
  } catch {
    return [];
  }

  const scoreMap = new Map(ranked.map((r) => [r.productId, r.score]));
  const recommendations: RecommendedProduct[] = cmrc_products
    .map((p) => ({
      productId: p.id,
      productName: p.name,
      price: p.price,
      imageUrl: p.image_url ?? undefined,
      sku: p.sku,
      coOccurrenceScore: scoreMap.get(p.id) ?? 0,
    }))
    .sort((a, b) => b.coOccurrenceScore - a.coOccurrenceScore)
    .slice(0, topN);

  if (withAiCopy && aiPlatformEnv && recommendations.length > 0) {
    try {
      const seedNames = await fetchProductNames(db, tenantId, seedProductIds);
      const recNames = recommendations.map((r) => r.productName);
      const copy = await generateRecommendationCopyViaAIPlatform(aiPlatformEnv, seedNames, recNames);
      recommendations.forEach((rec, i) => { rec.reason = copy[i] ?? undefined; });
    } catch { /* non-fatal */ }
  }

  return recommendations;
}

async function fetchProductNames(db: D1Database, tenantId: string, productIds: string[]): Promise<string[]> {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT name FROM cmrc_products WHERE id IN (${placeholders}) AND tenant_id = ?`
  ).bind(...productIds, tenantId).all<{ name: string }>();
  return results.map((r) => r.name);
}

// ─── Hono router ──────────────────────────────────────────────────────────────

import { Hono } from 'hono';
import { getTenantId } from '@webwaka/core';
import type { Env } from '../../worker';

export const recommendationsRouter = new Hono<{ Bindings: Env }>();

recommendationsRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

recommendationsRouter.get('/', async (c) => {
  const tenantId = getTenantId(c)!;
  const rawIds = c.req.query('product_ids') ?? '';
  const productIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  const topN = Math.min(Number(c.req.query('top_n') ?? 5), 20);
  const withAi = c.req.query('with_ai') === 'true';

  if (!productIds.length)
    return c.json({ success: false, error: 'product_ids query param required' }, 400);

  const recommendations = await getRecommendations(c.env.DB, tenantId, productIds, {
    topN,
    withAiCopy: withAi,
    aiPlatformEnv: { AI_PLATFORM_URL: c.env.AI_PLATFORM_URL, AI_PLATFORM_TOKEN: c.env.AI_PLATFORM_TOKEN },
  });

  return c.json({ success: true, data: { recommendations, count: recommendations.length } });
});
