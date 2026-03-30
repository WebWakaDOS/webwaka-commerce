/**
 * Shared in-memory rate limiter (P0-T06)
 *
 * Designed for Cloudflare Workers isolates where memory is per-isolate.
 * The `store` is passed in to enable test isolation — each caller owns
 * its own Map so tests never bleed into each other.
 *
 * Usage:
 *   const store = _createRateLimitStore();
 *   const allowed = checkRateLimit(store, `${tenantId}:${ip}`, 10, 60_000);
 */

export type RateLimitEntry = { count: number; windowStart: number };
export type RateLimitStore = Map<string, RateLimitEntry>;

/** Create an isolated rate-limit store. */
export function _createRateLimitStore(): RateLimitStore {
  return new Map<string, RateLimitEntry>();
}

/**
 * Check whether a given key is within its rate limit.
 *
 * @param store       The per-module Map tracking request windows.
 * @param key         Unique key (e.g. `"${tenantId}:${sessionId}"`).
 * @param maxRequests Maximum requests allowed in the window.
 * @param windowMs    Sliding window duration in milliseconds.
 * @returns           `true` if the request is allowed, `false` if throttled.
 */
export function checkRateLimit(
  store: RateLimitStore,
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    store.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= maxRequests) return false;
  entry.count++;
  return true;
}
