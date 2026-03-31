/**
 * @webwaka/core — Payment Abstractions
 * IPaymentProvider interface + PaystackProvider implementation.
 * Nigeria-first: Paystack split payments, transfers, refunds.
 * Uses fetch() only — Cloudflare Workers compatible.
 */

export interface ChargeResult {
  success: boolean;
  reference: string;
  amountKobo: number;
  error?: string;
}

export interface RefundResult {
  success: boolean;
  refundId: string;
  error?: string;
}

export interface SplitRecipient {
  subaccountCode: string;
  amountKobo: number;
}

export interface IPaymentProvider {
  verifyCharge(reference: string): Promise<ChargeResult>;
  initiateRefund(reference: string, amountKobo?: number): Promise<RefundResult>;
  initiateSplit(
    totalKobo: number,
    recipients: SplitRecipient[],
    reference: string,
  ): Promise<ChargeResult>;
  initiateTransfer(
    recipientCode: string,
    amountKobo: number,
    reference: string,
  ): Promise<{ success: boolean; transferCode: string; error?: string }>;
}

const PAYSTACK_BASE = 'https://api.paystack.co';

export class PaystackProvider implements IPaymentProvider {
  private secretKey: string;

  constructor(secretKey: string) {
    this.secretKey = secretKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  async verifyCharge(reference: string): Promise<ChargeResult> {
    try {
      const res = await fetch(
        `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: this.headers() },
      );
      if (!res.ok) {
        return { success: false, reference, amountKobo: 0, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        status: boolean;
        data?: { status: string; amount: number; reference: string };
      };
      const success = body.status === true && body.data?.status === 'success';
      return {
        success,
        reference: body.data?.reference ?? reference,
        amountKobo: body.data?.amount ?? 0,
        ...(!success ? { error: `Paystack status: ${body.data?.status ?? 'unknown'}` } : {}),
      };
    } catch (err) {
      return {
        success: false,
        reference,
        amountKobo: 0,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  async initiateRefund(reference: string, amountKobo?: number): Promise<RefundResult> {
    try {
      const payload: Record<string, unknown> = { transaction: reference };
      if (amountKobo !== undefined) payload.amount = amountKobo;

      const res = await fetch(`${PAYSTACK_BASE}/refund`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        return { success: false, refundId: '', error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        status: boolean;
        data?: { id: number | string };
        message?: string;
      };
      const success = body.status === true;
      return {
        success,
        refundId: success ? String(body.data?.id ?? '') : '',
        ...(!success ? { error: body.message ?? 'Refund failed' } : {}),
      };
    } catch (err) {
      return {
        success: false,
        refundId: '',
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  async initiateSplit(
    totalKobo: number,
    recipients: SplitRecipient[],
    reference: string,
  ): Promise<ChargeResult> {
    try {
      const subaccounts = recipients.map((r) => ({
        subaccount: r.subaccountCode,
        share: r.amountKobo,
      }));
      const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ amount: totalKobo, reference, split: { subaccounts } }),
      });
      if (!res.ok) {
        return { success: false, reference, amountKobo: totalKobo, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { status: boolean; message?: string };
      const success = body.status === true;
      return {
        success,
        reference,
        amountKobo: totalKobo,
        ...(!success ? { error: body.message ?? 'Split initialization failed' } : {}),
      };
    } catch (err) {
      return {
        success: false,
        reference,
        amountKobo: totalKobo,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  async initiateTransfer(
    recipientCode: string,
    amountKobo: number,
    reference: string,
  ): Promise<{ success: boolean; transferCode: string; error?: string }> {
    try {
      const res = await fetch(`${PAYSTACK_BASE}/transfer`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          source: 'balance',
          amount: amountKobo,
          recipient: recipientCode,
          reference,
        }),
      });
      if (!res.ok) {
        return { success: false, transferCode: '', error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as {
        status: boolean;
        data?: { transfer_code: string };
        message?: string;
      };
      const success = body.status === true;
      return {
        success,
        transferCode: success ? (body.data?.transfer_code ?? '') : '',
        ...(!success ? { error: body.message ?? 'Transfer failed' } : {}),
      };
    } catch (err) {
      return {
        success: false,
        transferCode: '',
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }
}

export function createPaymentProvider(secretKey: string): IPaymentProvider {
  return new PaystackProvider(secretKey);
}
