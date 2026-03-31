/**
 * @webwaka/core — Termii SMS Helper (enhanced, P01 canonical location)
 *
 * Enhanced sendTermiiSms with dev-mode bypass and DND-first channel default.
 * The root-level sendTermiiSms in index.ts is preserved as a backwards-compat wrapper.
 *
 * Dev-mode bypass: when apiKey is empty, returns { success: true, messageId: 'dev-mode-no-key' }
 * without making any network call. Safe for local development without Termii credentials.
 */

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

const TERMII_API_URL = 'https://api.ng.termii.com/api/sms/send';

/**
 * Send an SMS via Termii (Nigeria-first).
 *
 * - Empty apiKey → dev-mode bypass, no network call, returns mock messageId.
 * - Non-200 response → { success: false, error: 'Termii API error: <status>' }
 * - Network error → { success: false, error: <message> } — never throws.
 * - Default channel: 'dnd' (Nigerian DND registry, best deliverability).
 * - Default sender: 'WebWaka'.
 */
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
        to,
        from,
        sms: message,
        type: 'plain',
        channel,
        api_key: apiKey,
      }),
    });

    if (!res.ok) {
      return { success: false, error: `Termii API error: ${res.status}` };
    }

    const data = (await res.json()) as {
      code?: string;
      message_id?: string;
      message?: string;
    };

    const success = data.code === 'ok' || data.message === 'Successfully Sent';
    return {
      success,
      ...(data.message_id != null ? { messageId: data.message_id } : {}),
      ...(!success ? { error: data.message ?? 'Unknown error' } : {}),
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}
