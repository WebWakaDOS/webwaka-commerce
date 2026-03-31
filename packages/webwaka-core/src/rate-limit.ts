/**
 * @webwaka/core — KV-Backed Rate Limiter
 * Uses Cloudflare KV for distributed, persistent rate limiting across Worker instances.
 * Falls back to "allowed" when KV is unavailable (fail-open for availability).
 */

export interface RateLimitOptions {
  kv: KVNamespace;
  key: string;
  maxRequests: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

interface RateLimitState {
  count: number;
  windowStart: number;
}

export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const { kv, key, maxRequests, windowSeconds } = opts;
  const now = Date.now();
  const windowMs = windowSeconds * 1000;

  try {
    const raw = await kv.get(key);
    let state: RateLimitState;

    if (raw) {
      state = JSON.parse(raw) as RateLimitState;
      if (now - state.windowStart >= windowMs) {
        state = { count: 0, windowStart: now };
      }
    } else {
      state = { count: 0, windowStart: now };
    }

    const resetAt = state.windowStart + windowMs;

    if (state.count >= maxRequests) {
      return { allowed: false, remaining: 0, resetAt };
    }

    state.count += 1;
    const remaining = maxRequests - state.count;

    await kv.put(key, JSON.stringify(state), { expirationTtl: windowSeconds + 60 });

    return { allowed: true, remaining, resetAt };
  } catch {
    return { allowed: true, remaining: maxRequests, resetAt: now + windowMs };
  }
}
