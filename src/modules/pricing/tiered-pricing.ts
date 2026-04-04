/**
 * WebWaka — Tiered Pricing Engine
 * Implementation Plan §3 Item 3 + §5 Prompt 2
 *
 * Supports custom price lists for different customer segments:
 *   RETAIL    — standard retail price (default)
 *   VIP       — loyal customer discounted price
 *   WHOLESALE — bulk buyer discounted price
 *   B2B       — business-to-business negotiated price
 *   STAFF     — internal staff price
 *
 * Price tiers are stored as a JSON blob in the `price_tiers` column on the
 * `products` table (Cloudflare D1). Each tier entry is:
 *   { segment: CustomerSegment; price_kobo: number; min_quantity?: number }
 *
 * Invariants: Monetary values are integers (kobo). Build Once Use Infinitely.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type CustomerSegment = 'RETAIL' | 'VIP' | 'WHOLESALE' | 'B2B' | 'STAFF';

export interface PriceTier {
  segment: CustomerSegment;
  price_kobo: number;
  /** Minimum quantity required to unlock this tier (default 1). */
  min_quantity?: number;
  /** Optional label shown on the storefront (e.g. "Member Price"). */
  label?: string;
}

export interface TieredProduct {
  id: string;
  name: string;
  base_price_kobo: number;
  /** JSON-encoded array of PriceTier, or an already-parsed array. */
  price_tiers?: string | PriceTier[] | null;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse the `price_tiers` column. Returns an empty array if the value is
 * null, undefined, or malformed JSON.
 */
export function parsePriceTiers(raw: string | PriceTier[] | null | undefined): PriceTier[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as PriceTier[];
  } catch { /* malformed JSON — treat as no tiers */ }
  return [];
}

// ─── Core pricing logic ───────────────────────────────────────────────────────

/**
 * Resolve the effective price for a product given the customer's segment and
 * quantity. Falls back to `base_price_kobo` when no matching tier is found.
 *
 * When multiple tiers match (same segment, different min_quantity), the one
 * with the highest satisfied min_quantity wins (volume-based best deal).
 */
export function resolvePrice(
  product: TieredProduct,
  segment: CustomerSegment = 'RETAIL',
  quantity = 1,
): number {
  const tiers = parsePriceTiers(product.price_tiers);
  if (tiers.length === 0) return product.base_price_kobo;

  const eligible = tiers.filter(
    (t) =>
      t.segment === segment &&
      t.price_kobo > 0 &&
      quantity >= (t.min_quantity ?? 1),
  );

  if (eligible.length === 0) return product.base_price_kobo;

  // Best deal = highest min_quantity bracket satisfied (most specific tier)
  const best = eligible.reduce((a, b) =>
    (b.min_quantity ?? 1) > (a.min_quantity ?? 1) ? b : a,
  );

  return best.price_kobo;
}

/**
 * Compute the line total for a cart item, applying tiered pricing.
 */
export function computeLineTotal(
  product: TieredProduct,
  quantity: number,
  segment: CustomerSegment = 'RETAIL',
): number {
  return resolvePrice(product, segment, quantity) * quantity;
}

/**
 * Returns a human-readable label for the resolved price tier.
 * E.g. "VIP Price", "Wholesale (min 10 units)", "Retail Price"
 */
export function resolvePriceTierLabel(
  product: TieredProduct,
  segment: CustomerSegment = 'RETAIL',
  quantity = 1,
): string {
  const tiers = parsePriceTiers(product.price_tiers);
  const eligible = tiers.filter(
    (t) => t.segment === segment && quantity >= (t.min_quantity ?? 1),
  );
  if (eligible.length === 0) return 'Retail Price';
  const best = eligible.reduce((a, b) =>
    (b.min_quantity ?? 1) > (a.min_quantity ?? 1) ? b : a,
  );
  if (best.label) return best.label;
  const minQ = best.min_quantity;
  return minQ && minQ > 1
    ? `${segment} Price (min ${minQ} units)`
    : `${segment} Price`;
}

// ─── Catalog enrichment ───────────────────────────────────────────────────────

/**
 * Enrich an array of products with the effective price for a given segment.
 * Replaces `price` with the tier-resolved value and adds `original_price`
 * so the UI can display savings.
 */
export function applySegmentPricing<T extends TieredProduct>(
  products: T[],
  segment: CustomerSegment,
  quantity = 1,
): Array<T & { price: number; original_price: number; tier_label: string }> {
  return products.map((p) => {
    const price = resolvePrice(p, segment, quantity);
    return {
      ...p,
      price,
      original_price: p.base_price_kobo,
      tier_label: resolvePriceTierLabel(p, segment, quantity),
    };
  });
}

// ─── Tier management ─────────────────────────────────────────────────────────

/**
 * Validate that a price_tiers array is well-formed.
 * Throws with a descriptive message if invalid.
 */
export function validatePriceTiers(tiers: unknown[]): asserts tiers is PriceTier[] {
  const VALID_SEGMENTS: CustomerSegment[] = ['RETAIL', 'VIP', 'WHOLESALE', 'B2B', 'STAFF'];
  for (const [i, t] of tiers.entries()) {
    if (typeof t !== 'object' || t === null) throw new Error(`Tier[${i}] must be an object`);
    const tier = t as Record<string, unknown>;
    if (!VALID_SEGMENTS.includes(tier.segment as CustomerSegment)) {
      throw new Error(`Tier[${i}].segment must be one of ${VALID_SEGMENTS.join(', ')}`);
    }
    if (typeof tier.price_kobo !== 'number' || tier.price_kobo < 0) {
      throw new Error(`Tier[${i}].price_kobo must be a non-negative integer`);
    }
    if (tier.min_quantity !== undefined) {
      if (typeof tier.min_quantity !== 'number' || tier.min_quantity < 1 || !Number.isInteger(tier.min_quantity)) {
        throw new Error(`Tier[${i}].min_quantity must be a positive integer`);
      }
    }
  }
}

/**
 * Serialize price tiers to a JSON string suitable for D1 storage.
 */
export function serializePriceTiers(tiers: PriceTier[]): string {
  return JSON.stringify(tiers);
}

// ─── Segment resolution from JWT claims ──────────────────────────────────────

/**
 * Infer a CustomerSegment from a decoded JWT payload.
 * Priority: explicit `customer_segment` claim > `role` mapping > 'RETAIL'
 */
export function segmentFromJwtPayload(
  payload: Record<string, unknown> | null | undefined,
): CustomerSegment {
  if (!payload) return 'RETAIL';
  if (payload.customer_segment) return payload.customer_segment as CustomerSegment;
  const role = (payload.role as string | undefined)?.toUpperCase() ?? '';
  if (role === 'VIP' || role === 'VIP_CUSTOMER') return 'VIP';
  if (role === 'WHOLESALE' || role === 'WHOLESALER') return 'WHOLESALE';
  if (role === 'B2B' || role === 'B2B_BUYER') return 'B2B';
  if (role === 'STAFF' || role === 'EMPLOYEE') return 'STAFF';
  return 'RETAIL';
}
