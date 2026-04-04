/**
 * WebWaka — B2B Wholesale Portal Core
 * Implementation Plan §3 Item 2 — B2B Wholesale Portal
 * Implementation Plan §3 Item 3 — Tiered Pricing Engine (B2B dimension)
 *
 * Handles:
 *   - B2B buyer registration and approval workflow
 *   - Minimum Order Quantity (MOQ) validation
 *   - Bulk pricing with quantity break tiers
 *   - Credit-term order placement (Net 30/60/90)
 *   - Purchase order (PO) reference tracking
 *
 * Invariants: Multi-tenancy, Monetary values as integers (kobo),
 *             Nigeria-First, Build Once Use Infinitely
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type B2BAccountStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'SUSPENDED' | 'REJECTED';

export type CreditTerm = 'PREPAID' | 'NET_7' | 'NET_14' | 'NET_30' | 'NET_60' | 'NET_90';

export interface B2BAccount {
  id: string;
  tenantId: string;
  companyName: string;
  rcNumber?: string;           // CAC registration number
  taxId?: string;              // FIRS TIN
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  deliveryAddress: {
    street: string;
    lga: string;
    state: string;
  };
  creditTerm: CreditTerm;
  creditLimitKobo: number;     // 0 = no credit (prepaid)
  creditUsedKobo: number;
  status: B2BAccountStatus;
  approvedById?: string;
  approvedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface B2BOrderItem {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPriceKobo: number;       // negotiated / tiered price
  lineTotalKobo: number;
}

export type B2BOrderStatus =
  | 'DRAFT'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'CREDIT_PENDING';          // Approved on credit — awaiting payment term

export interface B2BOrder {
  id: string;
  tenantId: string;
  b2bAccountId: string;
  poReference?: string;        // Buyer's own purchase order reference
  items: B2BOrderItem[];
  subtotalKobo: number;
  vatKobo: number;             // 7.5% FIRS VAT
  totalKobo: number;
  discountKobo: number;
  creditTerm: CreditTerm;
  paymentDueAt?: number;       // epoch ms — null for PREPAID
  status: B2BOrderStatus;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MinimumOrderRule {
  productId?: string;          // null = applies to all products
  categoryId?: string;
  minQuantity: number;
  minValueKobo?: number;
}

// ─── MOQ validation ───────────────────────────────────────────────────────────

export interface MoqViolation {
  productId: string;
  productName: string;
  requestedQty: number;
  requiredQty: number;
}

/**
 * Validate that every line item meets its minimum order quantity.
 * Returns an array of violations (empty = all good).
 */
export function validateMoq(
  items: B2BOrderItem[],
  rules: MinimumOrderRule[],
): MoqViolation[] {
  const violations: MoqViolation[] = [];

  for (const item of items) {
    // Look for a product-specific rule first, then a global rule
    const rule =
      rules.find((r) => r.productId === item.productId) ??
      rules.find((r) => !r.productId && !r.categoryId);

    if (!rule) continue;

    if (item.quantity < rule.minQuantity) {
      violations.push({
        productId: item.productId,
        productName: item.productName,
        requestedQty: item.quantity,
        requiredQty: rule.minQuantity,
      });
    }
  }

  return violations;
}

// ─── Credit term helpers ──────────────────────────────────────────────────────

const CREDIT_TERM_DAYS: Record<CreditTerm, number | null> = {
  PREPAID: null,
  NET_7: 7,
  NET_14: 14,
  NET_30: 30,
  NET_60: 60,
  NET_90: 90,
};

/**
 * Compute the payment due date (epoch ms) for a credit-term order.
 * Returns null for PREPAID orders.
 */
export function computePaymentDueAt(
  creditTerm: CreditTerm,
  orderCreatedAt: number = Date.now(),
): number | null {
  const days = CREDIT_TERM_DAYS[creditTerm];
  if (days === null) return null;
  return orderCreatedAt + days * 24 * 60 * 60 * 1000;
}

/**
 * Check whether a B2B account has enough credit headroom for a given order.
 */
export function hasSufficientCredit(account: B2BAccount, orderTotalKobo: number): boolean {
  if (account.creditTerm === 'PREPAID') return true; // always OK — upfront payment
  const available = account.creditLimitKobo - account.creditUsedKobo;
  return orderTotalKobo <= available;
}

// ─── Order builder ────────────────────────────────────────────────────────────

const VAT_RATE = 0.075; // 7.5% FIRS VAT

/**
 * Build a B2BOrder from account + items. Does NOT persist to DB.
 */
export function buildB2BOrder(params: {
  tenantId: string;
  b2bAccountId: string;
  creditTerm: CreditTerm;
  items: Array<{ productId: string; productName: string; sku: string; quantity: number; unitPriceKobo: number }>;
  discountKobo?: number;
  poReference?: string;
  notes?: string;
}): B2BOrder {
  const now = Date.now();
  const id = `b2b_${now}_${Math.random().toString(36).slice(2, 9)}`;

  const orderItems: B2BOrderItem[] = params.items.map((i) => ({
    ...i,
    lineTotalKobo: i.unitPriceKobo * i.quantity,
  }));

  const subtotalKobo = orderItems.reduce((s, i) => s + i.lineTotalKobo, 0);
  const discountKobo = params.discountKobo ?? 0;
  const afterDiscount = Math.max(0, subtotalKobo - discountKobo);
  const vatKobo = Math.round(afterDiscount * VAT_RATE);
  const totalKobo = afterDiscount + vatKobo;

  const paymentDueAt = computePaymentDueAt(params.creditTerm, now);

  const status: B2BOrderStatus =
    params.creditTerm === 'PREPAID' ? 'PENDING_PAYMENT' : 'CREDIT_PENDING';

  return {
    id,
    tenantId: params.tenantId,
    b2bAccountId: params.b2bAccountId,
    poReference: params.poReference,
    items: orderItems,
    subtotalKobo,
    vatKobo,
    totalKobo,
    discountKobo,
    creditTerm: params.creditTerm,
    paymentDueAt: paymentDueAt ?? undefined,
    status,
    notes: params.notes,
    createdAt: now,
    updatedAt: now,
  };
}

// ─── Account registration ─────────────────────────────────────────────────────

/**
 * Generate a new B2B account object (pre-approval). Does NOT persist to DB.
 */
export function createB2BAccountRecord(params: {
  tenantId: string;
  companyName: string;
  rcNumber?: string;
  taxId?: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  deliveryAddress: B2BAccount['deliveryAddress'];
  requestedCreditTerm?: CreditTerm;
  requestedCreditLimitKobo?: number;
}): B2BAccount {
  const now = Date.now();
  return {
    id: `b2bacc_${now}_${Math.random().toString(36).slice(2, 9)}`,
    tenantId: params.tenantId,
    companyName: params.companyName,
    rcNumber: params.rcNumber,
    taxId: params.taxId,
    contactName: params.contactName,
    contactPhone: params.contactPhone,
    contactEmail: params.contactEmail,
    deliveryAddress: params.deliveryAddress,
    creditTerm: params.requestedCreditTerm ?? 'PREPAID',
    creditLimitKobo: params.requestedCreditLimitKobo ?? 0,
    creditUsedKobo: 0,
    status: 'PENDING_APPROVAL',
    createdAt: now,
    updatedAt: now,
  };
}
