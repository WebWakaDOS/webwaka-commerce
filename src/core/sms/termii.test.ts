/**
 * Termii SMS Helper Unit Tests (P0-T04)
 *
 * Tests the REAL sendTermiiSms function (direct import from webwaka-core source,
 * bypassing the Vitest mock alias).
 *
 * Scenarios:
 * 1. Dev-mode bypass (empty apiKey → no fetch, returns mock messageId)
 * 2. Successful API call → correct request body + returns messageId
 * 3. Non-200 response → returns { success: false, error: 'Termii API error: 422' }
 * 4. Network error (fetch throws) → returns { success: false, error: '...' } (never throws)
 * 5. Default channel is 'dnd'
 * 6. Custom channel and sender ID are forwarded
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the REAL implementation directly (not through the @webwaka/core alias)
import { sendTermiiSms } from '../../../packages/webwaka-core/src/sms/termii';

const TERMII_API_URL = 'https://api.ng.termii.com/api/sms/send';

describe('sendTermiiSms — @webwaka/core Termii SMS helper', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── Dev-mode bypass ──────────────────────────────────────────────────────

  it('should return dev-mode success when apiKey is empty string', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await sendTermiiSms({
      to: '+2348012345678',
      message: 'Test OTP: 123456',
      apiKey: '',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('dev-mode-no-key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should return dev-mode success when apiKey is falsy (undefined cast)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    const result = await sendTermiiSms({
      to: '+2348012345678',
      message: 'OTP: 654321',
      apiKey: '',
    });

    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Successful API call ──────────────────────────────────────────────────

  it('should call the Termii API with the correct request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok', message_id: 'msg_abc123' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendTermiiSms({
      to: '+2348099887766',
      message: 'Your WebWaka OTP is: 987654',
      apiKey: 'termii-test-key',
      channel: 'dnd',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(TERMII_API_URL, expect.objectContaining({
      method: 'POST',
    }));

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callArgs[1]?.body as string);
    expect(sentBody.api_key).toBe('termii-test-key');
    expect(sentBody.to).toBe('+2348099887766');
    expect(sentBody.sms).toBe('Your WebWaka OTP is: 987654');
    expect(sentBody.channel).toBe('dnd');
    expect(sentBody.type).toBe('plain');
  });

  it('should return messageId from API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok', message_id: 'msg_xyz789' }),
    }) as unknown as typeof fetch;

    const result = await sendTermiiSms({
      to: '+2348012345678',
      message: 'Hello',
      apiKey: 'key-123',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_xyz789');
  });

  it('should default to dnd channel when channel is not specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendTermiiSms({
      to: '+2348012345678',
      message: 'Test',
      apiKey: 'key',
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callArgs[1]?.body as string);
    expect(sentBody.channel).toBe('dnd');
  });

  it('should use whatsapp channel when specified', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendTermiiSms({
      to: '+2348012345678',
      message: 'Cart nudge',
      apiKey: 'key',
      channel: 'whatsapp',
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callArgs[1]?.body as string);
    expect(sentBody.channel).toBe('whatsapp');
  });

  it('should use custom sender ID when from is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendTermiiSms({
      to: '+2348012345678',
      message: 'Hello from custom sender',
      apiKey: 'key',
      from: 'MyShop',
    });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callArgs[1]?.body as string);
    expect(sentBody.from).toBe('MyShop');
  });

  it('should default sender to WebWaka when from is not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'ok' }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendTermiiSms({ to: '+2348012345678', message: 'Test', apiKey: 'key' });

    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(callArgs[1]?.body as string);
    expect(sentBody.from).toBe('WebWaka');
  });

  // ── Error handling ────────────────────────────────────────────────────────

  it('should return { success: false } on non-200 response — never throw', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
    }) as unknown as typeof fetch;

    const result = await sendTermiiSms({
      to: '+2348012345678',
      message: 'OTP',
      apiKey: 'key',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Termii API error: 422');
  });

  it('should return { success: false } when fetch throws — never throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure')) as unknown as typeof fetch;

    const result = await sendTermiiSms({
      to: '+2348012345678',
      message: 'OTP',
      apiKey: 'key',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network failure');
  });

  it('should never throw even on unexpected errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue('string-error') as unknown as typeof fetch;

    await expect(
      sendTermiiSms({ to: '+2348012345678', message: 'OTP', apiKey: 'key' }),
    ).resolves.not.toThrow();
  });
});
