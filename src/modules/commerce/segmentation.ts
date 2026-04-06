/**
 * WebWaka — Customer Segmentation
 * Implementation Plan §3 Item 17 — Customer Segmentation
 *
 * Group cmrc_customers based on purchase history and Lifetime Value (LTV):
 *   - RFM Model: Recency (last purchase), Frequency (order count), Monetary (total spend)
 *   - Segments: CHAMPIONS, LOYAL, AT_RISK, LOST, NEW, POTENTIAL_LOYALIST, CANT_LOSE
 *   - Segment data drives Abandoned Cart recovery, promo targeting, and loyalty tiers
 *
 * Invariants: NDPR (privacy-safe — no PII in segment labels), Nigeria-First,
 *             Multi-tenancy, Build Once Use Infinitely
 */

import { Hono } from 'hono';
import { getTenantId, requireRole } from '@webwaka/core';
import type { Env } from '../../worker';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSegmentLabel =
  | 'CHAMPIONS'          // High R, High F, High M — best cmrc_customers
  | 'LOYAL_CUSTOMERS'    // High F, High M, moderate R
  | 'POTENTIAL_LOYALIST' // Recent cmrc_customers with moderate frequency
  | 'NEW_CUSTOMERS'      // Recent first-time buyers
  | 'AT_RISK'            // Formerly frequent, not purchased recently
  | 'CANT_LOSE_THEM'     // High spend historically, long dormant
  | 'LOST'               // Low R, Low F, Low M — churned
  | 'HIBERNATING'        // Low engagement, low frequency
  | 'ABOUT_TO_SLEEP';    // Starting to fade

export interface RFMScore {
  customerId: string;
  customerPhone?: string;
  customerEmail?: string;
  recencyDays: number;           // days since last purchase (lower = better)
  frequencyCount: number;        // number of cmrc_orders
  monetaryKobo: number;          // total spend
  rScore: number;                // 1-5 (5 = best)
  fScore: number;
  mScore: number;
  rfmScore: number;              // weighted composite
  segment: CustomerSegmentLabel;
  lastPurchaseAt: number;
  firstPurchaseAt: number;
}

// ─── RFM scoring ──────────────────────────────────────────────────────────────

/**
 * Assign a 1-5 score to a metric value, given percentile breakpoints.
 * For Recency: lower days = better (score is inverted).
 */
export function scorePercentile(value: number, breakpoints: number[], invert = false): number {
  // breakpoints: [20th, 40th, 60th, 80th percentile values]
  let score = 1;
  for (const bp of breakpoints) {
    if (value >= bp) score++;
  }
  return invert ? 6 - score : score;
}

/**
 * Classify a customer into an RFM segment based on R, F, M scores.
 */
export function classifySegment(r: number, f: number, m: number): CustomerSegmentLabel {
  const avg = (r + f + m) / 3;

  if (r >= 4 && f >= 4 && m >= 4) return 'CHAMPIONS';
  if (r >= 3 && f >= 4 && m >= 3) return 'LOYAL_CUSTOMERS';
  if (r >= 4 && f <= 2) return 'NEW_CUSTOMERS';
  if (r >= 3 && f >= 2 && m >= 2) return 'POTENTIAL_LOYALIST';
  if (r <= 2 && f >= 3 && m >= 3) return 'AT_RISK';
  if (r <= 2 && f >= 4 && m >= 4) return 'CANT_LOSE_THEM';
  if (r <= 2 && f <= 2 && m >= 3) return 'HIBERNATING';
  if (avg >= 2.5) return 'ABOUT_TO_SLEEP';
  return 'LOST';
}

// ─── D1 aggregation ───────────────────────────────────────────────────────────

/**
 * Compute RFM scores for all cmrc_customers of a tenant using order history.
 * Runs a single aggregation query to avoid N+1 pattern.
 */
export async function computeRfmScores(
  db: D1Database,
  tenantId: string,
  lookbackDays = 365,
): Promise<RFMScore[]> {
  const since = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  interface OrderSummaryRow {
    customer_id: string;
    customer_phone: string | null;
    customer_email: string | null;
    last_order_at: number;
    first_order_at: number;
    order_count: number;
    total_spend_kobo: number;
  }

  let rows: OrderSummaryRow[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT customer_phone as customer_id,
              customer_phone,
              customer_email,
              MAX(created_at) as last_order_at,
              MIN(created_at) as first_order_at,
              COUNT(*) as order_count,
              SUM(total_amount) as total_spend_kobo
       FROM cmrc_orders
       WHERE tenant_id = ? AND created_at >= ?
         AND order_status NOT IN ('CANCELLED', 'FAILED')
         AND customer_phone IS NOT NULL
       GROUP BY customer_phone
       HAVING order_count >= 1
       ORDER BY total_spend_kobo DESC
       LIMIT 1000`
    ).bind(tenantId, since).all<OrderSummaryRow>();
    rows = results;
  } catch {
    return [];
  }

  if (!rows.length) return [];

  // Compute percentile breakpoints
  const recencies = rows.map((r) => Math.floor((now - r.last_order_at) / (24 * 60 * 60 * 1000)));
  const frequencies = rows.map((r) => r.order_count);
  const monetaries = rows.map((r) => r.total_spend_kobo);

  const pct = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[idx] ?? 0;
  };

  const rBps = [pct(recencies, 80), pct(recencies, 60), pct(recencies, 40), pct(recencies, 20)]; // inverted
  const fBps = [pct(frequencies, 20), pct(frequencies, 40), pct(frequencies, 60), pct(frequencies, 80)];
  const mBps = [pct(monetaries, 20), pct(monetaries, 40), pct(monetaries, 60), pct(monetaries, 80)];

  return rows.map((row) => {
    const recencyDays = Math.floor((now - row.last_order_at) / (24 * 60 * 60 * 1000));
    const rScore = scorePercentile(recencyDays, rBps, true); // invert — fewer days = higher score
    const fScore = scorePercentile(row.order_count, fBps, false);
    const mScore = scorePercentile(row.total_spend_kobo, mBps, false);
    const rfmScore = (rScore * 0.4 + fScore * 0.3 + mScore * 0.3) * 20; // 0-100

    return {
      customerId: row.customer_id,
      customerPhone: row.customer_phone ?? undefined,
      customerEmail: row.customer_email ?? undefined,
      recencyDays,
      frequencyCount: row.order_count,
      monetaryKobo: row.total_spend_kobo,
      rScore,
      fScore,
      mScore,
      rfmScore: Math.round(rfmScore),
      segment: classifySegment(rScore, fScore, mScore),
      lastPurchaseAt: row.last_order_at,
      firstPurchaseAt: row.first_order_at,
    };
  });
}

/**
 * Get cmrc_customers in a specific segment.
 */
export async function getSegmentCustomers(
  db: D1Database,
  tenantId: string,
  segment: CustomerSegmentLabel,
): Promise<RFMScore[]> {
  const scores = await computeRfmScores(db, tenantId);
  return scores.filter((s) => s.segment === segment);
}

// ─── Hono router ──────────────────────────────────────────────────────────────

export const segmentationRouter = new Hono<{ Bindings: Env }>();

segmentationRouter.use('*', async (c, next) => {
  if (!getTenantId(c)) return c.json({ success: false, error: 'Missing x-tenant-id' }, 400);
  await next();
});

/** GET /api/commerce/segmentation/rfm — compute and return RFM analysis */
segmentationRouter.get(
  '/rfm',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const lookbackDays = Number(c.req.query('lookback_days') ?? 365);
    const segment = c.req.query('segment') as CustomerSegmentLabel | undefined;

    const scores = await computeRfmScores(c.env.DB, tenantId, lookbackDays);
    const filtered = segment ? scores.filter((s) => s.segment === segment) : scores;

    // Segment summary
    const summary: Record<string, number> = {};
    for (const s of scores) {
      summary[s.segment] = (summary[s.segment] ?? 0) + 1;
    }

    return c.json({
      success: true,
      data: {
        total_customers: scores.length,
        segment_summary: summary,
        cmrc_customers: filtered,
        lookback_days: lookbackDays,
      },
    });
  }
);

/** GET /api/commerce/segmentation/segments — list available segments with counts */
segmentationRouter.get(
  '/segments',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']),
  async (c) => {
    const tenantId = getTenantId(c)!;
    const scores = await computeRfmScores(c.env.DB, tenantId);

    const summary: Record<string, { count: number; avg_monetary_kobo: number; avg_rfm_score: number }> = {};
    for (const s of scores) {
      if (!summary[s.segment]) {
        summary[s.segment] = { count: 0, avg_monetary_kobo: 0, avg_rfm_score: 0 };
      }
      summary[s.segment]!.count++;
      summary[s.segment]!.avg_monetary_kobo += s.monetaryKobo;
      summary[s.segment]!.avg_rfm_score += s.rfmScore;
    }

    for (const seg of Object.values(summary)) {
      if (seg.count > 0) {
        seg.avg_monetary_kobo = Math.round(seg.avg_monetary_kobo / seg.count);
        seg.avg_rfm_score = Math.round(seg.avg_rfm_score / seg.count);
      }
    }

    return c.json({ success: true, data: summary });
  }
);
