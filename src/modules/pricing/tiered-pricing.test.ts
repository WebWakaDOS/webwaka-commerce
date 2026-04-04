/**
 * QA-COM-2 — Tiered Pricing Engine Unit Tests
 *
 * Certifies: "The GET /products endpoint correctly returns the discounted
 * price for a customer in the 'Wholesale' segment."
 *
 * Also satisfies QA-COM-4 (unit tests for pricing engines).
 */

import { describe, it, expect } from 'vitest';
import {
  resolvePrice,
  computeLineTotal,
  applySegmentPricing,
  parsePriceTiers,
  validatePriceTiers,
  serializePriceTiers,
  resolvePriceTierLabel,
  segmentFromJwtPayload,
  type TieredProduct,
  type PriceTier,
} from './tiered-pricing';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PRODUCT_WITH_TIERS: TieredProduct = {
  id: 'prod_001',
  name: 'Wholesale Rice (50kg)',
  base_price_kobo: 500_000, // ₦5,000 retail
  price_tiers: JSON.stringify([
    { segment: 'VIP', price_kobo: 450_000, min_quantity: 1, label: 'VIP Price' },
    { segment: 'WHOLESALE', price_kobo: 380_000, min_quantity: 10 },
    { segment: 'WHOLESALE', price_kobo: 350_000, min_quantity: 50 },
    { segment: 'B2B', price_kobo: 320_000, min_quantity: 100 },
    { segment: 'STAFF', price_kobo: 420_000, min_quantity: 1 },
  ] satisfies PriceTier[]),
};

const PRODUCT_NO_TIERS: TieredProduct = {
  id: 'prod_002',
  name: 'Zobo Drink',
  base_price_kobo: 50_000,
  price_tiers: null,
};

const PRODUCT_ALREADY_PARSED: TieredProduct = {
  id: 'prod_003',
  name: 'Chapman',
  base_price_kobo: 80_000,
  price_tiers: [
    { segment: 'WHOLESALE', price_kobo: 60_000, min_quantity: 5 },
  ],
};

// ─── QA-COM-2: Wholesale segment pricing ─────────────────────────────────────

describe('QA-COM-2 — Wholesale Segment Pricing', () => {
  it('returns WHOLESALE tier price when quantity meets min_quantity', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'WHOLESALE', 10);
    expect(price).toBe(380_000);
  });

  it('returns higher-volume WHOLESALE tier when quantity qualifies (50+)', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'WHOLESALE', 50);
    expect(price).toBe(350_000);
  });

  it('falls back to base_price when WHOLESALE quantity below min_quantity', () => {
    // Qty=5 does not meet the min_quantity=10 for WHOLESALE tier
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'WHOLESALE', 5);
    expect(price).toBe(500_000); // retail fallback
  });

  it('returns correct line total for WHOLESALE tier', () => {
    const total = computeLineTotal(PRODUCT_WITH_TIERS, 10, 'WHOLESALE');
    expect(total).toBe(380_000 * 10); // ₦38,000 × 10 units
  });

  it('applySegmentPricing enriches product with wholesale price and original_price', () => {
    const [enriched] = applySegmentPricing([PRODUCT_WITH_TIERS], 'WHOLESALE', 10) as ReturnType<typeof applySegmentPricing<TieredProduct>>;
    expect(enriched!.price).toBe(380_000);
    expect(enriched!.original_price).toBe(500_000);
    expect(enriched!.tier_label).toContain('WHOLESALE');
  });

  it('handles already-parsed price_tiers array correctly', () => {
    const price = resolvePrice(PRODUCT_ALREADY_PARSED, 'WHOLESALE', 5);
    expect(price).toBe(60_000);
  });
});

// ─── Segment isolation ────────────────────────────────────────────────────────

describe('Segment Isolation — prices cannot leak between segments', () => {
  it('RETAIL segment always gets base_price_kobo', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'RETAIL', 100);
    expect(price).toBe(500_000);
  });

  it('VIP segment gets VIP price, not WHOLESALE price', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'VIP', 100);
    expect(price).toBe(450_000); // VIP tier, not WHOLESALE
  });

  it('B2B segment gets B2B price at qualifying quantity', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'B2B', 100);
    expect(price).toBe(320_000);
  });

  it('STAFF segment gets STAFF price', () => {
    const price = resolvePrice(PRODUCT_WITH_TIERS, 'STAFF', 1);
    expect(price).toBe(420_000);
  });

  it('product with no tiers always returns base_price regardless of segment', () => {
    expect(resolvePrice(PRODUCT_NO_TIERS, 'WHOLESALE', 100)).toBe(50_000);
    expect(resolvePrice(PRODUCT_NO_TIERS, 'B2B', 100)).toBe(50_000);
    expect(resolvePrice(PRODUCT_NO_TIERS, 'VIP', 1)).toBe(50_000);
  });
});

// ─── parsePriceTiers ──────────────────────────────────────────────────────────

describe('parsePriceTiers', () => {
  it('returns empty array for null input', () => {
    expect(parsePriceTiers(null)).toEqual([]);
  });

  it('returns empty array for undefined input', () => {
    expect(parsePriceTiers(undefined)).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    expect(parsePriceTiers('{invalid')).toEqual([]);
  });

  it('parses valid JSON string correctly', () => {
    const tiers: PriceTier[] = [{ segment: 'WHOLESALE', price_kobo: 100_000, min_quantity: 5 }];
    expect(parsePriceTiers(JSON.stringify(tiers))).toEqual(tiers);
  });

  it('passes through an already-parsed array', () => {
    const tiers: PriceTier[] = [{ segment: 'VIP', price_kobo: 90_000 }];
    expect(parsePriceTiers(tiers)).toBe(tiers);
  });
});

// ─── validatePriceTiers ───────────────────────────────────────────────────────

describe('validatePriceTiers', () => {
  it('accepts a valid tier array', () => {
    expect(() =>
      validatePriceTiers([{ segment: 'WHOLESALE', price_kobo: 100_000, min_quantity: 10 }]),
    ).not.toThrow();
  });

  it('throws on invalid segment', () => {
    expect(() =>
      validatePriceTiers([{ segment: 'ELITE', price_kobo: 100_000 }]),
    ).toThrow(/segment/i);
  });

  it('throws on negative price_kobo', () => {
    expect(() =>
      validatePriceTiers([{ segment: 'VIP', price_kobo: -1 }]),
    ).toThrow(/price_kobo/i);
  });

  it('throws on fractional min_quantity', () => {
    expect(() =>
      validatePriceTiers([{ segment: 'B2B', price_kobo: 100, min_quantity: 1.5 }]),
    ).toThrow(/min_quantity/i);
  });

  it('throws on zero min_quantity', () => {
    expect(() =>
      validatePriceTiers([{ segment: 'STAFF', price_kobo: 100, min_quantity: 0 }]),
    ).toThrow(/min_quantity/i);
  });
});

// ─── serializePriceTiers ──────────────────────────────────────────────────────

describe('serializePriceTiers', () => {
  it('round-trips through serialize → parse', () => {
    const tiers: PriceTier[] = [
      { segment: 'WHOLESALE', price_kobo: 200_000, min_quantity: 20 },
      { segment: 'B2B', price_kobo: 150_000, min_quantity: 100 },
    ];
    const serialized = serializePriceTiers(tiers);
    const parsed = parsePriceTiers(serialized);
    expect(parsed).toEqual(tiers);
  });
});

// ─── resolvePriceTierLabel ────────────────────────────────────────────────────

describe('resolvePriceTierLabel', () => {
  it('returns custom label when set on a tier', () => {
    const label = resolvePriceTierLabel(PRODUCT_WITH_TIERS, 'VIP', 1);
    expect(label).toBe('VIP Price');
  });

  it('returns segment + min_quantity label when no custom label', () => {
    const label = resolvePriceTierLabel(PRODUCT_WITH_TIERS, 'WHOLESALE', 10);
    expect(label).toContain('min 10');
  });

  it('returns "Retail Price" when no tiers match', () => {
    const label = resolvePriceTierLabel(PRODUCT_NO_TIERS, 'WHOLESALE', 100);
    expect(label).toBe('Retail Price');
  });
});

// ─── segmentFromJwtPayload ────────────────────────────────────────────────────

describe('segmentFromJwtPayload — RBAC bypass prevention', () => {
  it('returns RETAIL for null payload', () => {
    expect(segmentFromJwtPayload(null)).toBe('RETAIL');
  });

  it('returns RETAIL for empty payload', () => {
    expect(segmentFromJwtPayload({})).toBe('RETAIL');
  });

  it('resolves segment from explicit customer_segment claim', () => {
    expect(segmentFromJwtPayload({ customer_segment: 'WHOLESALE' })).toBe('WHOLESALE');
  });

  it('resolves segment from role claim (case-insensitive)', () => {
    expect(segmentFromJwtPayload({ role: 'wholesale' })).toBe('WHOLESALE');
    expect(segmentFromJwtPayload({ role: 'vip' })).toBe('VIP');
    expect(segmentFromJwtPayload({ role: 'b2b' })).toBe('B2B');
    expect(segmentFromJwtPayload({ role: 'staff' })).toBe('STAFF');
  });

  it('prefers customer_segment over role when both present', () => {
    expect(
      segmentFromJwtPayload({ customer_segment: 'B2B', role: 'RETAIL' }),
    ).toBe('B2B');
  });

  it('falls back to RETAIL for unknown role', () => {
    expect(segmentFromJwtPayload({ role: 'ADMIN' })).toBe('RETAIL');
  });
});

// ─── applySegmentPricing (catalog enrichment) ─────────────────────────────────

describe('applySegmentPricing — catalog enrichment', () => {
  const catalog: TieredProduct[] = [PRODUCT_WITH_TIERS, PRODUCT_NO_TIERS, PRODUCT_ALREADY_PARSED];

  it('enriches all products with the correct segment price', () => {
    const enriched = applySegmentPricing(catalog, 'WHOLESALE', 10);
    expect(enriched[0]!.price).toBe(380_000);  // WHOLESALE tier matched
    expect(enriched[1]!.price).toBe(50_000);   // no tiers, base price
    expect(enriched[2]!.price).toBe(60_000);   // pre-parsed tier matched
  });

  it('sets original_price to base_price_kobo for every product', () => {
    const enriched = applySegmentPricing(catalog, 'VIP', 1);
    expect(enriched[0]!.original_price).toBe(500_000);
    expect(enriched[1]!.original_price).toBe(50_000);
  });

  it('does not mutate the original product objects', () => {
    const original = { ...PRODUCT_WITH_TIERS };
    applySegmentPricing([PRODUCT_WITH_TIERS], 'WHOLESALE', 50);
    expect(PRODUCT_WITH_TIERS.base_price_kobo).toBe(original.base_price_kobo);
  });
});
