/**
 * WebWaka — Termii SMS Helper
 *
 * Nigeria-First: uses Termii (https://termii.com) for OTP and notification SMS.
 *
 * Features:
 * - Dev-mode bypass: empty apiKey → no HTTP call, returns mock messageId
 * - Default channel: 'dnd' (required for DND-registered Nigerian numbers)
 * - Default sender: 'WebWaka'
 * - Never throws — always returns a result object
 */

const TERMII_API_URL = 'https://api.ng.termii.com/api/sms/send';

export interface TermiiSendSmsOptions {
  to: string;
  message: string;
  apiKey: string;
  channel?: 'generic' | 'dnd' | 'whatsapp';
  from?: string;
}

export interface TermiiSendSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export async function sendTermiiSms(opts: TermiiSendSmsOptions): Promise<TermiiSendSmsResult> {
  const { to, message, apiKey, channel = 'dnd', from = 'WebWaka' } = opts;

  if (!apiKey) {
    return { success: true, messageId: 'dev-mode-no-key' };
  }

  try {
    const res = await fetch(TERMII_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        to,
        sms: message,
        channel,
        type: 'plain',
        from,
      }),
    });

    if (!res.ok) {
      return { success: false, error: `Termii API error: ${res.status}` };
    }

    const data = await res.json() as { message_id?: string };
    return { success: true, messageId: data.message_id };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
