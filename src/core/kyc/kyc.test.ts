/**
 * P08 KYC Provider Unit Tests
 *
 * Tests the REAL SmileIdentityProvider + createKycProvider from webwaka-core source.
 * Direct import bypasses the Vitest @webwaka/core mock alias.
 * fetch() is stubbed per-test using vi.stubGlobal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SmileIdentityProvider, createKycProvider } from '../../../packages/webwaka-core/src/kyc';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  return vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── SmileIdentityProvider — BVN ─────────────────────────────────────────────

describe('SmileIdentityProvider.verifyBvn', () => {
  const provider = new SmileIdentityProvider(
    'sandbox_partner_001',
    'sandbox_api_key_001',
    'prembly_key',
    'prembly_app',
    'sandbox',
  );

  it('returns verified:true when ResultCode is 1012 (known test BVN)', async () => {
    mockFetch({
      ResultCode: '1012',
      ResultText: 'BVN Verification Successful',
      ConfidenceValue: '0.96',
    });

    const result = await provider.verifyBvn(
      '22200000001',
      'Chukwu',
      'Emeka',
      '1990-01-15',
    );

    expect(result.verified).toBe(true);
    expect(result.provider).toBe('smile_identity');
    expect(result.reason).toBe('BVN Verification Successful');
    expect(result.matchScore).toBeCloseTo(0.96);
  });

  it('returns verified:false when ResultCode is not 1012', async () => {
    mockFetch({
      ResultCode: '1016',
      ResultText: 'Name mismatch',
      ConfidenceValue: '0.42',
    });

    const result = await provider.verifyBvn('22200000002', 'Wrong', 'Name', '1990-01-01');

    expect(result.verified).toBe(false);
    expect(result.provider).toBe('smile_identity');
    expect(result.reason).toBe('Name mismatch');
  });

  it('returns provider_error gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

    const result = await provider.verifyBvn('22200000003', 'A', 'B', '1995-01-01');

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.provider).toBe('smile_identity');
  });

  it('returns provider_error when HTTP response is not ok', async () => {
    mockFetch({ error: 'Unauthorized' }, 401);

    const result = await provider.verifyBvn('22200000004', 'A', 'B', '1995-01-01');

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.provider).toBe('smile_identity');
  });

  it('sends correct request body to Smile Identity sandbox endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ResultCode: '1012', ResultText: 'Verified', ConfidenceValue: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider.verifyBvn('22200000005', 'Ngozi', 'Obi', '1988-06-20');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('testapi.smileidentity.com');
    expect(url).toContain('/id_verification');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.id_type).toBe('BVN');
    expect(body.id_number).toBe('22200000005');
    expect(body.country).toBe('NG');
    expect(body.dob).toBe('1988-06-20');
  });
});

// ─── SmileIdentityProvider — NIN ─────────────────────────────────────────────

describe('SmileIdentityProvider.verifyNin', () => {
  const provider = new SmileIdentityProvider(
    'sandbox_partner_001',
    'sandbox_api_key_001',
    'prembly_key',
    'prembly_app',
    'sandbox',
  );

  it('sandbox round-trip: returns verified:true when ResultCode is 1012', async () => {
    mockFetch({
      ResultCode: '1012',
      ResultText: 'NIN Verification Successful',
      ConfidenceValue: 0.98,
    });

    const result = await provider.verifyNin('12345678901', 'Adeola', 'Adeyemi');

    expect(result.verified).toBe(true);
    expect(result.provider).toBe('smile_identity');
    expect(result.matchScore).toBeCloseTo(0.98);
    expect(result.reason).toBe('NIN Verification Successful');
  });

  it('does NOT include dob in the NIN request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ResultCode: '1012', ResultText: 'ok', ConfidenceValue: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await provider.verifyNin('12345678902', 'Aminu', 'Kano');

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.id_type).toBe('NIN');
    expect(body).not.toHaveProperty('dob');
    expect(body.country).toBe('NG');
  });

  it('returns verified:false gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS error')));

    const result = await provider.verifyNin('12345678903', 'A', 'B');

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.provider).toBe('smile_identity');
  });
});

// ─── SmileIdentityProvider — CAC (Prembly) ───────────────────────────────────

describe('SmileIdentityProvider.verifyCac', () => {
  const provider = new SmileIdentityProvider(
    'sandbox_partner_001',
    'sandbox_api_key_001',
    'invalid_prembly_key',
    'invalid_prembly_app',
    'sandbox',
  );

  it('returns verified:false with reason provider_error when API key is invalid (HTTP 401)', async () => {
    mockFetch({ message: 'Unauthorized', status: false }, 401);

    const result = await provider.verifyCac('RC12345', 'Acme Nigeria Ltd');

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.provider).toBe('prembly');
  });

  it('returns verified:true when company_name matches (case-insensitive)', async () => {
    mockFetch({
      status: true,
      data: {
        company_name: 'ACME NIGERIA LIMITED',
        rc_number: 'RC12345',
      },
    });

    const result = await provider.verifyCac('RC12345', 'acme nigeria');

    expect(result.verified).toBe(true);
    expect(result.provider).toBe('prembly');
  });

  it('returns verified:false with mismatch reason when name does not match', async () => {
    mockFetch({
      status: true,
      data: {
        company_name: 'DANGOTE CEMENT PLC',
        rc_number: 'RC99999',
      },
    });

    const result = await provider.verifyCac('RC99999', 'Acme Nigeria Ltd');

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('mismatch');
    expect(result.reason).toContain('DANGOTE CEMENT PLC');
    expect(result.provider).toBe('prembly');
  });

  it('returns provider_error gracefully when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    const result = await provider.verifyCac('RC12345', 'Acme Nigeria');

    expect(result.verified).toBe(false);
    expect(result.reason).toBe('provider_error');
    expect(result.provider).toBe('prembly');
  });

  it('sends correct headers and rc_number to Prembly endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: true, data: { company_name: 'Acme Nigeria Ltd' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const providerWithCreds = new SmileIdentityProvider(
      'p_id', 'p_key', 'pk_prembly_test', 'app_prembly_test', 'sandbox',
    );
    await providerWithCreds.verifyCac('RC55555', 'Acme Nigeria');

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('prembly.com');
    expect((opts.headers as Record<string, string>)['x-api-key']).toBe('pk_prembly_test');
    expect((opts.headers as Record<string, string>)['app-id']).toBe('app_prembly_test');
    const body = JSON.parse(opts.body as string) as Record<string, unknown>;
    expect(body.rc_number).toBe('RC55555');
  });
});

// ─── createKycProvider factory ────────────────────────────────────────────────

describe('createKycProvider', () => {
  it('returns an IKycProvider instance with all three methods', () => {
    const provider = createKycProvider('pid', 'akey', 'pkey', 'appid');
    expect(typeof provider.verifyBvn).toBe('function');
    expect(typeof provider.verifyNin).toBe('function');
    expect(typeof provider.verifyCac).toBe('function');
  });

  it('defaults to sandbox environment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ResultCode: '1012', ResultText: 'ok', ConfidenceValue: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createKycProvider('pid', 'akey', 'pkey', 'appid');
    await provider.verifyBvn('000', 'A', 'B', '2000-01-01');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('testapi.smileidentity.com');
  });

  it('uses production endpoint when environment is production', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ResultCode: '1012', ResultText: 'ok', ConfidenceValue: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = createKycProvider('pid', 'akey', 'pkey', 'appid', 'production');
    await provider.verifyBvn('000', 'A', 'B', '2000-01-01');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('api.smileidentity.com');
    expect(url).not.toContain('testapi');
  });
});
