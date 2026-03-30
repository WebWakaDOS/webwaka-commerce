/**
 * checkRateLimit utility tests (P0-T06)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkRateLimit, _createRateLimitStore } from './rate-limit';

afterEach(() => {
  vi.useRealTimers();
});

describe('checkRateLimit', () => {
  it('allows the first request for a new key', () => {
    const store = _createRateLimitStore();
    expect(checkRateLimit(store, 'tenant1:session1', 5, 60_000)).toBe(true);
  });

  it('allows requests up to maxRequests within the window', () => {
    const store = _createRateLimitStore();
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(store, 'tenant1:s', 5, 60_000)).toBe(true);
    }
  });

  it('throttles on the (maxRequests + 1)th request within the window', () => {
    const store = _createRateLimitStore();
    for (let i = 0; i < 5; i++) {
      checkRateLimit(store, 'key', 5, 60_000);
    }
    expect(checkRateLimit(store, 'key', 5, 60_000)).toBe(false);
  });

  it('resets the window after windowMs has elapsed', () => {
    vi.useFakeTimers();
    const store = _createRateLimitStore();
    for (let i = 0; i < 5; i++) checkRateLimit(store, 'key', 5, 60_000);
    expect(checkRateLimit(store, 'key', 5, 60_000)).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(checkRateLimit(store, 'key', 5, 60_000)).toBe(true);
  });

  it('isolates different keys independently', () => {
    const store = _createRateLimitStore();
    for (let i = 0; i < 5; i++) checkRateLimit(store, 'keyA', 5, 60_000);
    expect(checkRateLimit(store, 'keyA', 5, 60_000)).toBe(false);
    expect(checkRateLimit(store, 'keyB', 5, 60_000)).toBe(true);
  });

  it('separate stores do not interfere (test isolation)', () => {
    const storeA = _createRateLimitStore();
    const storeB = _createRateLimitStore();
    for (let i = 0; i < 5; i++) checkRateLimit(storeA, 'key', 5, 60_000);
    expect(checkRateLimit(storeA, 'key', 5, 60_000)).toBe(false);
    expect(checkRateLimit(storeB, 'key', 5, 60_000)).toBe(true);
  });

  it('maxRequests=1 allows first, throttles second', () => {
    const store = _createRateLimitStore();
    expect(checkRateLimit(store, 'k', 1, 60_000)).toBe(true);
    expect(checkRateLimit(store, 'k', 1, 60_000)).toBe(false);
  });
});
