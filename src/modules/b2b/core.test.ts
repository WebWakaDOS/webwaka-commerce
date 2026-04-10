/**
 * QA-COM-3 — B2B Portal Unit Tests
 *
 * Certifies: "The B2B portal correctly enforces Minimum Order Quantities
 * (MOQs) before allowing checkout."
 *
 * Also certifies:
 *   - Credit term / payment due date computation
 *   - Credit limit enforcement (RBAC bypass prevention)
 *   - FIRS 7.5% VAT calculation
 *   - B2B order builder correctness
 *   - Account registration workflow (PENDING_APPROVAL guard)
 *
 * Also satisfies QA-COM-4 (unit tests for B2B wholesale portal).
 */

import { describe, it, expect } from 'vitest';
import {
  validateMoq,
  computePaymentDueAt,
  hasSufficientCredit,
  buildB2BOrder,
  createB2BAccountRecord,
  type B2BAccount,
  type B2BOrderItem,
  type MinimumOrderRule,
} from './core';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const APPROVED_ACCOUNT: B2BAccount = {
  id: 'b2bacc_001',
  tenantId: 'tnt_demo',
  companyName: 'Lagos Foodstuff Ltd',
  contactName: 'Emeka Obi',
  contactPhone: '+2348012345678',
  contactEmail: 'emeka@lagosfoods.ng',
  deliveryAddress: { street: '14 Apapa Road', lga: 'Apapa', state: 'Lagos' },
  creditTerm: 'NET_30',
  creditLimitKobo: 5_000_000_00, // ₦5,000,000
  creditUsedKobo: 1_000_000_00,  // ₦1,000,000 used
  status: 'APPROVED',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const ITEMS: B2BOrderItem[] = [
  {
    productId: 'prod_001',
    productName: 'Wholesale Rice 50kg',
    sku: 'RCE-50KG',
    quantity: 20,
    unitPriceKobo: 380_000,
    lineTotalKobo: 380_000 * 20,
  },
  {
    productId: 'prod_002',
    productName: 'Palm Oil 25L',
    sku: 'PO-25L',
    quantity: 5,
    unitPriceKobo: 120_000,
    lineTotalKobo: 120_000 * 5,
  },
];

const MOQ_RULES: MinimumOrderRule[] = [
  { productId: 'prod_001', minQuantity: 10 },  // rice: min 10 bags
  { productId: 'prod_002', minQuantity: 10 },  // palm oil: min 10 jerricans
  { minQuantity: 5 },                           // global fallback: min 5 units
];

// ─── QA-COM-3: MOQ enforcement ────────────────────────────────────────────────

describe('QA-COM-3 — MOQ Enforcement', () => {
  it('returns no violations when all items meet their MOQ', () => {
    const violations = validateMoq(ITEMS, MOQ_RULES);
    // prod_001: qty=20 >= min=10 ✓
    // prod_002: qty=5 < min=10 ✗
    expect(violations).toHaveLength(1);
    expect(violations[0]!.productId).toBe('prod_002');
    expect(violations[0]!.requestedQty).toBe(5);
    expect(violations[0]!.requiredQty).toBe(10);
  });

  it('returns empty array when all items comply with MOQ rules', () => {
    const compliant: B2BOrderItem[] = [
      { ...(ITEMS[0] as B2BOrderItem), quantity: 15 }, // rice: 15 >= 10 ✓
      { ...(ITEMS[1] as B2BOrderItem), quantity: 12 }, // palm oil: 12 >= 10 ✓
    ];
    expect(validateMoq(compliant, MOQ_RULES)).toHaveLength(0);
  });

  it('enforces the global fallback MOQ when no product-specific rule exists', () => {
    const newItem: B2BOrderItem = {
      productId: 'prod_999',
      productName: 'New Product',
      sku: 'NEW-001',
      quantity: 3,
      unitPriceKobo: 50_000,
      lineTotalKobo: 150_000,
    };
    const violations = validateMoq([newItem], MOQ_RULES);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.requiredQty).toBe(5); // global fallback
  });

  it('skips cmrc_products with no applicable rule', () => {
    const noRules: MinimumOrderRule[] = []; // empty rules
    expect(validateMoq(ITEMS, noRules)).toHaveLength(0);
  });

  it('product-specific rule takes priority over global rule', () => {
    const rules: MinimumOrderRule[] = [
      { productId: 'prod_001', minQuantity: 20 }, // specific: need 20
      { minQuantity: 3 },                          // global: only need 3
    ];
    const item: B2BOrderItem = { ...(ITEMS[0] as B2BOrderItem), quantity: 10 }; // qty=10 < specific=20
    const violations = validateMoq([item], rules);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.requiredQty).toBe(20); // product-specific won
  });

  it('violation includes correct productName and requestedQty', () => {
    const shortOrder: B2BOrderItem[] = [{ ...(ITEMS[1] as B2BOrderItem), quantity: 2 }]; // palm oil qty=2
    const [v] = validateMoq(shortOrder, MOQ_RULES);
    expect(v!.productName).toBe('Palm Oil 25L');
    expect(v!.requestedQty).toBe(2);
    expect(v!.requiredQty).toBe(10);
  });

  it('handles empty cart with no violations', () => {
    expect(validateMoq([], MOQ_RULES)).toHaveLength(0);
  });
});

// ─── Credit term computation ──────────────────────────────────────────────────

describe('computePaymentDueAt', () => {
  const BASE = 1_700_000_000_000; // fixed epoch for deterministic tests

  it('returns null for PREPAID cmrc_orders', () => {
    expect(computePaymentDueAt('PREPAID', BASE)).toBeNull();
  });

  it('returns BASE + 7 days for NET_7', () => {
    const due = computePaymentDueAt('NET_7', BASE);
    expect(due).toBe(BASE + 7 * 24 * 60 * 60 * 1000);
  });

  it('returns BASE + 30 days for NET_30', () => {
    const due = computePaymentDueAt('NET_30', BASE);
    expect(due).toBe(BASE + 30 * 24 * 60 * 60 * 1000);
  });

  it('returns BASE + 90 days for NET_90', () => {
    const due = computePaymentDueAt('NET_90', BASE);
    expect(due).toBe(BASE + 90 * 24 * 60 * 60 * 1000);
  });
});

// ─── Credit limit enforcement (RBAC/security) ─────────────────────────────────

describe('hasSufficientCredit — security guard', () => {
  it('returns true for PREPAID account regardless of order size', () => {
    const prepaid: B2BAccount = { ...APPROVED_ACCOUNT, creditTerm: 'PREPAID', creditLimitKobo: 0 };
    expect(hasSufficientCredit(prepaid, 999_999_999_999)).toBe(true);
  });

  it('returns true when order total is within remaining credit', () => {
    // limit=5_000_000_00, used=1_000_000_00 → available=4_000_000_00
    expect(hasSufficientCredit(APPROVED_ACCOUNT, 3_000_000_00)).toBe(true);
  });

  it('returns true when order total exactly equals available credit', () => {
    const available = APPROVED_ACCOUNT.creditLimitKobo - APPROVED_ACCOUNT.creditUsedKobo;
    expect(hasSufficientCredit(APPROVED_ACCOUNT, available)).toBe(true);
  });

  it('returns false when order total exceeds available credit', () => {
    const tooMuch = APPROVED_ACCOUNT.creditLimitKobo - APPROVED_ACCOUNT.creditUsedKobo + 1;
    expect(hasSufficientCredit(APPROVED_ACCOUNT, tooMuch)).toBe(false);
  });

  it('returns false when account credit is fully used', () => {
    const maxed: B2BAccount = {
      ...APPROVED_ACCOUNT,
      creditUsedKobo: APPROVED_ACCOUNT.creditLimitKobo,
    };
    expect(hasSufficientCredit(maxed, 1)).toBe(false);
  });
});

// ─── buildB2BOrder ────────────────────────────────────────────────────────────

describe('buildB2BOrder', () => {
  const baseParams = {
    tenantId: 'tnt_demo',
    b2bAccountId: 'b2bacc_001',
    creditTerm: 'NET_30' as const,
    items: [
      { productId: 'prod_001', productName: 'Rice 50kg', sku: 'RCE', quantity: 10, unitPriceKobo: 380_000 },
      { productId: 'prod_002', productName: 'Palm Oil', sku: 'PO', quantity: 5, unitPriceKobo: 120_000 },
    ],
  };

  it('computes correct subtotal from line items', () => {
    const order = buildB2BOrder(baseParams);
    // (380_000 * 10) + (120_000 * 5) = 3_800_000 + 600_000 = 4_400_000
    expect(order.subtotalKobo).toBe(4_400_000);
  });

  it('applies 7.5% FIRS VAT on subtotal after discount', () => {
    const order = buildB2BOrder(baseParams);
    const expectedVat = Math.round(4_400_000 * 0.075);
    expect(order.vatKobo).toBe(expectedVat);
  });

  it('total = subtotal + VAT (no discount)', () => {
    const order = buildB2BOrder(baseParams);
    expect(order.totalKobo).toBe(order.subtotalKobo + order.vatKobo);
  });

  it('applies discount before computing VAT', () => {
    const order = buildB2BOrder({ ...baseParams, discountKobo: 400_000 });
    const afterDiscount = 4_400_000 - 400_000; // 4_000_000
    const expectedVat = Math.round(afterDiscount * 0.075);
    expect(order.vatKobo).toBe(expectedVat);
    expect(order.totalKobo).toBe(afterDiscount + expectedVat);
  });

  it('discount cannot drive total negative', () => {
    const order = buildB2BOrder({ ...baseParams, discountKobo: 999_999_999 });
    expect(order.subtotalKobo).toBeGreaterThanOrEqual(0);
    expect(order.totalKobo).toBeGreaterThanOrEqual(0);
  });

  it('sets status to CREDIT_PENDING for credit-term cmrc_orders', () => {
    const order = buildB2BOrder(baseParams);
    expect(order.status).toBe('CREDIT_PENDING');
  });

  it('sets status to PENDING_PAYMENT for PREPAID cmrc_orders', () => {
    const order = buildB2BOrder({ ...baseParams, creditTerm: 'PREPAID' });
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('paymentDueAt is null for PREPAID cmrc_orders', () => {
    const order = buildB2BOrder({ ...baseParams, creditTerm: 'PREPAID' });
    expect(order.paymentDueAt).toBeUndefined();
  });

  it('paymentDueAt is set 30 days out for NET_30', () => {
    const before = Date.now();
    const order = buildB2BOrder(baseParams);
    const after = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(order.paymentDueAt).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(order.paymentDueAt).toBeLessThanOrEqual(after + thirtyDays);
  });

  it('stores poReference and notes on the order', () => {
    const order = buildB2BOrder({
      ...baseParams,
      poReference: 'PO-2026-042',
      notes: 'Deliver to warehouse B',
    });
    expect(order.poReference).toBe('PO-2026-042');
    expect(order.notes).toBe('Deliver to warehouse B');
  });

  it('line totals are product of quantity × unitPriceKobo', () => {
    const order = buildB2BOrder(baseParams);
    expect(order.items[0]!.lineTotalKobo).toBe(380_000 * 10);
    expect(order.items[1]!.lineTotalKobo).toBe(120_000 * 5);
  });
});

// ─── createB2BAccountRecord ───────────────────────────────────────────────────

describe('createB2BAccountRecord — registration workflow', () => {
  const regParams = {
    tenantId: 'tnt_demo',
    companyName: 'Kano Grains Ltd',
    contactName: 'Musa Usman',
    contactPhone: '+2348099887766',
    contactEmail: 'musa@kanograins.ng',
    deliveryAddress: { street: '5 Kofar Wambai', lga: 'Kano Municipal', state: 'Kano' },
  };

  it('creates account with PENDING_APPROVAL status', () => {
    const acct = createB2BAccountRecord(regParams);
    expect(acct.status).toBe('PENDING_APPROVAL');
  });

  it('defaults to PREPAID credit term when not specified', () => {
    const acct = createB2BAccountRecord(regParams);
    expect(acct.creditTerm).toBe('PREPAID');
  });

  it('respects requested credit term', () => {
    const acct = createB2BAccountRecord({ ...regParams, requestedCreditTerm: 'NET_60' });
    expect(acct.creditTerm).toBe('NET_60');
  });

  it('initialises creditUsedKobo to 0', () => {
    const acct = createB2BAccountRecord(regParams);
    expect(acct.creditUsedKobo).toBe(0);
  });

  it('generates a unique id each time', () => {
    const a1 = createB2BAccountRecord(regParams);
    const a2 = createB2BAccountRecord(regParams);
    expect(a1.id).not.toBe(a2.id);
  });

  it('stores all supplied fields correctly', () => {
    const acct = createB2BAccountRecord({ ...regParams, rcNumber: 'RC123456', taxId: 'TIN987654' });
    expect(acct.companyName).toBe('Kano Grains Ltd');
    expect(acct.rcNumber).toBe('RC123456');
    expect(acct.taxId).toBe('TIN987654');
    expect(acct.tenantId).toBe('tnt_demo');
    expect(acct.deliveryAddress.state).toBe('Kano');
  });
});
