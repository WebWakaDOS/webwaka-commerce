/**
 * WebWaka — AI Product Recommendations
 * Implementation Plan §3 Item 5 — AI Product Recommendations
 * Implementation Plan §4 Phase 3 — AI & Automation
 *
 * "Frequently Bought Together" engine using two approaches:
 *
 *   1. Local co-occurrence matrix (edge-computed, zero latency, no API cost)
 *      Built from order history stored in Cloudflare D1.
 *
 *   2. OpenRouter LLM enrichment (optional) — generates natural-language
 *      recommendation copy for the storefront ("Pairs well with…").
 *
 * Invariants: Nigeria-First, Build Once Use Infinitely, Offline-tolerant
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecommendedProduct {
  productId: string;
  productName: string;
  price: number;             // kobo
  imageUrl?: string;
  sku: string;
  coOccurrenceScore: number; // higher = more often bought together
  reason?: string;           // AI-generated copy (optional)
}

export interface CoOccurrenceEntry {
  productA: string;
  productB: string;
  count: number;
}

// ─── D1 query helpers ─────────────────────────────────────────────────────────

/**
 * Build a co-occurrence matrix from recent order history in Cloudflare D1.
 * Reads `order_items` joined to `orders` (last 90 days by default).
 *
 * Called server-side from the Hono worker. Returns top pairs sorted by count.
 */
export async function computeCoOccurrenceMatrix(
  db: D1Database,
  tenantId: string,
  lookbackDays = 90,
  limit = 200,
): Promise<CoOccurrenceEntry[]> {
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  try {
    // Self-join order_items on the same order to find pairs
    const { results } = await db.prepare(
      `SELECT oi1.product_id AS product_a,
              oi2.product_id AS product_b,
              COUNT(*) AS co_count
       FROM order_items oi1
       JOIN order_items oi2
         ON oi1.order_id = oi2.order_id
         AND oi1.product_id < oi2.product_id
       JOIN orders o ON o.id = oi1.order_id
       WHERE o.tenant_id = ?
         AND o.created_at >= ?
         AND o.order_status NOT IN ('CANCELLED', 'FAILED')
       GROUP BY oi1.product_id, oi2.product_id
       ORDER BY co_count DESC
       LIMIT ?`
    ).bind(tenantId, since, limit).all<{ product_a: string; product_b: string; co_count: number }>();

    return results.map((r) => ({
      productA: r.product_a,
      productB: r.product_b,
      count: r.co_count,
    }));
  } catch {
    return []; // Graceful degradation — order_items may not yet exist
  }
}

/**
 * Get frequently-bought-together product IDs for a given product or cart.
 * Returns product IDs ranked by co-occurrence, excluding already-in-cart items.
 *
 * @param matrix  Pre-computed co-occurrence matrix (call computeCoOccurrenceMatrix once per request)
 * @param seedIds Product IDs already in the cart / currently being viewed
 * @param exclude Product IDs to exclude (already in cart, already shown)
 * @param topN    How many recommendations to return
 */
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
    const aIsSeed = seedSet.has(productA);
    const bIsSeed = seedSet.has(productB);

    if (aIsSeed && !excludeSet.has(productB)) {
      scoreMap.set(productB, (scoreMap.get(productB) ?? 0) + count);
    }
    if (bIsSeed && !excludeSet.has(productA)) {
      scoreMap.set(productA, (scoreMap.get(productA) ?? 0) + count);
    }
  }

  return Array.from(scoreMap.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([productId, score]) => ({ productId, score }));
}

/**
 * Full recommendation pipeline:
 *  1. Compute co-occurrence pairs from D1
 *  2. Score against seed products
 *  3. Fetch product details for top candidates
 *  4. Optionally enrich with AI copy via OpenRouter
 */
export async function getRecommendations(
  db: D1Database,
  tenantId: string,
  seedProductIds: string[],
  options: {
    openRouterApiKey?: string;
    topN?: number;
    excludeIds?: string[];
    withAiCopy?: boolean;
  } = {},
): Promise<RecommendedProduct[]> {
  if (!seedProductIds.length) return [];

  const { topN = 5, excludeIds = [], withAiCopy = false, openRouterApiKey } = options;

  // Step 1: Build matrix
  const matrix = await computeCoOccurrenceMatrix(db, tenantId);

  // Step 2: Score
  const ranked = getFrequentlyBoughtTogether(matrix, seedProductIds, excludeIds, topN * 2);
  if (!ranked.length) return [];

  // Step 3: Fetch product details
  const productIds = ranked.map((r) => r.productId);
  const placeholders = productIds.map(() => '?').join(',');
  interface ProductRow { id: string; name: string; price: number; image_url: string | null; sku: string }

  let products: ProductRow[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT id, name, price, image_url, sku FROM products
       WHERE id IN (${placeholders}) AND tenant_id = ? AND is_active = 1 AND deleted_at IS NULL`
    ).bind(...productIds, tenantId).all<ProductRow>();
    products = results;
  } catch {
    return [];
  }

  // Map scores back to products
  const scoreMap = new Map(ranked.map((r) => [r.productId, r.score]));
  const recommendations: RecommendedProduct[] = products
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

  // Step 4: Optional AI copy enrichment
  if (withAiCopy && openRouterApiKey && recommendations.length > 0) {
    try {
      const seedNames = await fetchProductNames(db, tenantId, seedProductIds);
      const recNames = recommendations.map((r) => r.productName);
      const copy = await generateRecommendationCopy(
        openRouterApiKey,
        seedNames,
        recNames,
      );
      // Map copy to recommendations by index
      recommendations.forEach((rec, i) => {
        rec.reason = copy[i] ?? undefined;
      });
    } catch {
      // AI enrichment is non-fatal — proceed without copy
    }
  }

  return recommendations;
}

// ─── OpenRouter AI copy generation ────────────────────────────────────────────

async function fetchProductNames(
  db: D1Database,
  tenantId: string,
  productIds: string[],
): Promise<string[]> {
  if (!productIds.length) return [];
  const placeholders = productIds.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT name FROM products WHERE id IN (${placeholders}) AND tenant_id = ?`
  ).bind(...productIds, tenantId).all<{ name: string }>();
  return results.map((r) => r.name);
}

/**
 * Generate short recommendation copy for each recommended product using OpenRouter.
 * Returns an array of strings parallel to `recommendedNames`.
 * e.g. "Great with Jollof Rice — customers who bought this also loved it."
 */
async function generateRecommendationCopy(
  apiKey: string,
  seedNames: string[],
  recommendedNames: string[],
): Promise<string[]> {
  const prompt = `You are a Nigerian e-commerce copywriter. 
A customer is buying: ${seedNames.join(', ')}.
Write ONE short recommendation sentence (max 12 words) for each of these items that pairs well with it:
${recommendedNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}
Respond ONLY with a JSON array of strings, one per item. No explanation.`;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://webwaka.com',
    },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 256,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`OpenRouter error: ${res.status}`);
  const json = await res.json() as { choices: Array<{ message: { content: string } }> };
  const content = json.choices[0]?.message?.content ?? '[]';
  const parsed = JSON.parse(content) as string[];
  return Array.isArray(parsed) ? parsed : [];
}

// ─── Recommendations API router (for Hono mounting) ──────────────────────────

import { Hono } from 'hono';
import { getTenantId } from '@webwaka/core';
import type { Env } from '../../worker';

export const recommendationsRouter = new Hono<{ Bindings: Env }>();

recommendationsRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/recommendations?product_ids=id1,id2&top_n=5&with_ai=false */
recommendationsRouter.get('/', async (c) => {
  const tenantId = getTenantId(c)!;
  const rawIds = c.req.query('product_ids') ?? '';
  const productIds = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  const topN = Math.min(Number(c.req.query('top_n') ?? 5), 20);
  const withAi = c.req.query('with_ai') === 'true';

  if (!productIds.length) {
    return c.json({ success: false, error: 'product_ids query param required' }, 400);
  }

  const recommendations = await getRecommendations(c.env.DB, tenantId, productIds, {
    topN,
    withAiCopy: withAi,
    openRouterApiKey: c.env.OPENROUTER_API_KEY,
  });

  return c.json({ success: true, data: { recommendations, count: recommendations.length } });
});
