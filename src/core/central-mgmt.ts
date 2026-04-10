/**
 * WebWaka Commerce — Central Management Ledger Event Publisher
 *
 * Publishes order payment and payout events to the webwaka-central-mgmt service
 * for double-entry ledger recording.
 *
 * Event types published:
 *   - commerce.order.paid        → triggered on Paystack charge.success webhook
 *   - commerce.payout.processed  → triggered on Paystack transfer.success webhook
 *
 * Authentication: Authorization: Bearer {INTER_SERVICE_SECRET}
 *
 * Blueprint Reference: Part 10.1 (Central Management & Economics)
 * Added: 2026-04-01 — Remediation Issue #9 (missing commerce→central-mgmt hook)
 */

interface CentralMgmtEnv {
  CENTRAL_MGMT_URL?: string;
  INTER_SERVICE_SECRET?: string;
}

interface LedgerEventPayload {
  event_type: string;
  aggregate_id: string;
  tenant_id?: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/**
 * Publish a ledger event to the central-mgmt service.
 * Non-fatal: failures are logged but do not block the calling transaction.
 */
async function publishToLedger(env: CentralMgmtEnv, event: LedgerEventPayload): Promise<void> {
  const url = env.CENTRAL_MGMT_URL;
  const secret = env.INTER_SERVICE_SECRET;

  if (!url || !secret) {
    console.warn('[commerce→central-mgmt] CENTRAL_MGMT_URL or INTER_SERVICE_SECRET not configured — skipping ledger event', {
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
    });
    return;
  }

  try {
    const res = await fetch(`${url}/events/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`,
      },
      body: JSON.stringify(event),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[commerce→central-mgmt] Ledger event rejected', {
        status: res.status,
        event_type: event.event_type,
        aggregate_id: event.aggregate_id,
        response: text.slice(0, 200),
      });
    }
  } catch (err) {
    console.error('[commerce→central-mgmt] Network error publishing ledger event', {
      event_type: event.event_type,
      aggregate_id: event.aggregate_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Notify central-mgmt of a paid order.
 * Called after Paystack charge.success webhook marks order as paid.
 *
 * @param env             Worker environment
 * @param orderId         Internal order ID
 * @param tenantId        Tenant scoping
 * @param amountKobo      Total order amount in kobo (integer)
 * @param commissionBps   Platform commission in basis points (default 500 = 5%)
 * @param paymentRef      Paystack payment reference
 */
export async function notifyOrderPaid(
  env: CentralMgmtEnv,
  orderId: string,
  tenantId: string,
  amountKobo: number,
  commissionBps: number = 500,
  paymentRef: string,
): Promise<void> {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    console.warn('[commerce→central-mgmt] Invalid amountKobo for order.paid', { orderId, amountKobo });
    return;
  }
  await publishToLedger(env, {
    event_type: 'commerce.order.paid',
    aggregate_id: orderId,
    tenant_id: tenantId,
    payload: {
      order_id: orderId,
      tenant_id: tenantId,
      amount_kobo: amountKobo,
      commission_bps: commissionBps,
      payment_reference: paymentRef,
    },
    timestamp: Date.now(),
  });
}

/**
 * Notify central-mgmt of a processed vendor payout.
 * Called after Paystack transfer.success webhook marks payout as paid.
 *
 * @param env           Worker environment
 * @param payoutId      Internal payout request ID
 * @param vendorId      Vendor ID for account tracking
 * @param tenantId      Tenant scoping
 * @param amountKobo    Payout amount in kobo (integer)
 * @param transferCode  Paystack transfer code
 */
export async function notifyPayoutProcessed(
  env: CentralMgmtEnv,
  payoutId: string,
  vendorId: string,
  tenantId: string,
  amountKobo: number,
  transferCode: string,
): Promise<void> {
  if (!Number.isInteger(amountKobo) || amountKobo <= 0) {
    console.warn('[commerce→central-mgmt] Invalid amountKobo for payout.processed', { payoutId, amountKobo });
    return;
  }
  await publishToLedger(env, {
    event_type: 'commerce.payout.processed',
    aggregate_id: payoutId,
    tenant_id: tenantId,
    payload: {
      payout_id: payoutId,
      vendor_id: vendorId,
      tenant_id: tenantId,
      amount_kobo: amountKobo,
      transfer_code: transferCode,
    },
    timestamp: Date.now(),
  });
}
