/**
 * @webwaka/core — Termii SMS Helper (backwards-compat wrapper, P01)
 *
 * sendTermiiSms wraps TermiiProvider internally and adds:
 *   - Dev-mode bypass: empty apiKey → no network call, returns { success: true, messageId: 'dev-mode-no-key' }
 *   - DND-first channel default ('dnd' is the Nigerian DND registry channel)
 *   - Passthrough of raw Termii channel strings ('dnd', 'generic', 'whatsapp')
 *
 * All callers in webwaka-commerce and webwaka-logistics should migrate to
 * ISmsProvider / TermiiProvider (from '@webwaka/core'). This function is kept
 * for backward compatibility only.
 */

import { TermiiProvider } from '../sms';

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

/**
 * Send an SMS via Termii (Nigeria-first).
 * Wraps TermiiProvider.sendRaw internally.
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

  const provider = new TermiiProvider(apiKey, from);
  const result = await provider.sendRaw(to, message, channel, from);

  return {
    success: result.success,
    ...(result.messageId != null ? { messageId: result.messageId } : {}),
    ...(result.error != null ? { error: result.error } : {}),
  };
}
