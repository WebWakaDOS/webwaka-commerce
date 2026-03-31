/**
 * @webwaka/core — SMS / OTP Delivery Abstractions
 * ISmsProvider interface + TermiiProvider implementation.
 * Nigeria-first: WhatsApp primary, SMS fallback.
 * Preserves backwards-compatible sendTermiiSms wrapper (re-exported from ./sms/termii).
 */

export type OtpChannel = 'sms' | 'whatsapp' | 'whatsapp_business';

export interface OtpResult {
  success: boolean;
  messageId?: string;
  channel: OtpChannel;
  error?: string;
}

export interface ISmsProvider {
  sendOtp(to: string, message: string, channel?: OtpChannel): Promise<OtpResult>;
  sendMessage(to: string, message: string): Promise<OtpResult>;
}

const TERMII_ENDPOINT = 'https://api.ng.termii.com/api/sms/send';

export class TermiiProvider implements ISmsProvider {
  private apiKey: string;
  private senderId: string;

  constructor(apiKey: string, senderId = 'WebWaka') {
    this.apiKey = apiKey;
    this.senderId = senderId;
  }

  private async _send(
    to: string,
    message: string,
    channel: OtpChannel,
  ): Promise<OtpResult> {
    const termiiChannel =
      channel === 'whatsapp' || channel === 'whatsapp_business' ? 'whatsapp' : 'generic';

    try {
      const res = await fetch(TERMII_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          from: this.senderId,
          sms: message,
          type: 'plain',
          channel: termiiChannel,
          api_key: this.apiKey,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'unknown');
        return { success: false, channel, error: `HTTP ${res.status}: ${text}` };
      }

      const data = (await res.json()) as {
        code?: string;
        message_id?: string;
        message?: string;
      };

      const success = data.code === 'ok' || data.message === 'Successfully Sent';
      return {
        success,
        channel,
        ...(data.message_id != null ? { messageId: data.message_id } : {}),
        ...(!success ? { error: data.message ?? 'Unknown error' } : {}),
      };
    } catch (err) {
      return {
        success: false,
        channel,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  /**
   * Send directly to Termii with a raw channel string (e.g. 'dnd', 'whatsapp', 'generic').
   * Used by the sendTermiiSms backwards-compat wrapper which needs to pass Termii-native
   * channel values (including 'dnd') without the OtpChannel mapping.
   */
  async sendRaw(
    to: string,
    message: string,
    rawChannel: string,
    fromSender?: string,
  ): Promise<OtpResult> {
    const otpChannel: OtpChannel = rawChannel === 'whatsapp' ? 'whatsapp' : 'sms';
    const senderFrom = fromSender ?? this.senderId;

    try {
      const res = await fetch(TERMII_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to,
          from: senderFrom,
          sms: message,
          type: 'plain',
          channel: rawChannel,
          api_key: this.apiKey,
        }),
      });

      if (!res.ok) {
        return { success: false, channel: otpChannel, error: `Termii API error: ${res.status}` };
      }

      const data = (await res.json()) as {
        code?: string;
        message_id?: string;
        message?: string;
      };

      const success = data.code === 'ok' || data.message === 'Successfully Sent';
      return {
        success,
        channel: otpChannel,
        ...(data.message_id != null ? { messageId: data.message_id } : {}),
        ...(!success ? { error: data.message ?? 'Unknown error' } : {}),
      };
    } catch (err) {
      return {
        success: false,
        channel: otpChannel,
        error: err instanceof Error ? err.message : 'Network error',
      };
    }
  }

  async sendOtp(to: string, message: string, channel: OtpChannel = 'whatsapp'): Promise<OtpResult> {
    const result = await this._send(to, message, channel);

    if (!result.success && (channel === 'whatsapp' || channel === 'whatsapp_business')) {
      return this._send(to, message, 'sms');
    }

    return result;
  }

  /**
   * Send a non-OTP message. Uses WhatsApp as primary channel with automatic SMS fallback.
   * Spec: sendMessage calls sendOtp with 'whatsapp' channel.
   */
  async sendMessage(to: string, message: string): Promise<OtpResult> {
    return this.sendOtp(to, message, 'whatsapp');
  }
}

export function createSmsProvider(apiKey: string, senderId?: string): ISmsProvider {
  return new TermiiProvider(apiKey, senderId);
}
