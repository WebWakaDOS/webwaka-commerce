/**
 * generatePayRef utility tests (P0-T06)
 */

import { describe, it, expect } from 'vitest';
import { generatePayRef } from './pay-ref';

describe('generatePayRef', () => {
  it('starts with PAY_', () => {
    expect(generatePayRef()).toMatch(/^PAY_/);
  });

  it('has exactly 16 characters (PAY_ + 12 hex chars)', () => {
    expect(generatePayRef()).toHaveLength(16);
  });

  it('suffix is uppercase alphanumeric (hex subset)', () => {
    const suffix = generatePayRef().slice(4);
    expect(suffix).toMatch(/^[A-F0-9]{12}$/);
  });

  it('generates unique values on consecutive calls', () => {
    const refs = new Set(Array.from({ length: 100 }, () => generatePayRef()));
    expect(refs.size).toBe(100);
  });
});
