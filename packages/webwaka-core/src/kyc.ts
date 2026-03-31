/**
 * @webwaka/core — KYC Provider Interface + Implementations (P08)
 * Nigeria regulatory compliance: BVN, NIN, CAC (RC Number) verification.
 *
 * Providers:
 *   - SmileIdentityProvider — BVN & NIN verification via Smile Identity v1 API
 *   - Prembly (composed inside SmileIdentityProvider) — CAC verification
 *
 * All implementations use only fetch() — Cloudflare Workers compatible.
 * Network errors are caught and returned as { verified: false, reason: 'provider_error' }.
 */

export interface KycVerificationResult {
  verified: boolean;
  matchScore?: number;
  reason?: string;
  provider: string;
}

export interface IKycProvider {
  verifyBvn(
    bvnHash: string,
    firstName: string,
    lastName: string,
    dob: string,
  ): Promise<KycVerificationResult>;

  verifyNin(
    ninHash: string,
    firstName: string,
    lastName: string,
  ): Promise<KycVerificationResult>;

  verifyCac(
    rcNumber: string,
    businessName: string,
  ): Promise<KycVerificationResult>;
}

// ─── Smile Identity ──────────────────────────────────────────────────────────

const SMILE_BASE_PRODUCTION = 'https://api.smileidentity.com/v1';
const SMILE_BASE_SANDBOX = 'https://testapi.smileidentity.com/v1';

// ─── Prembly ─────────────────────────────────────────────────────────────────

const PREMBLY_CAC_URL = 'https://api.prembly.com/identitypass/verification/cac';

/**
 * SmileIdentityProvider — implements IKycProvider.
 *
 * BVN + NIN verification use the Smile Identity v1 /id_verification endpoint.
 * CAC verification is delegated to the Prembly IdentityPass API (composed in
 * the same class for a single provider entry-point).
 */
export class SmileIdentityProvider implements IKycProvider {
  private readonly partnerId: string;
  private readonly apiKey: string;
  private readonly environment: 'sandbox' | 'production';
  private readonly premblyApiKey: string;
  private readonly premblyAppId: string;

  constructor(
    partnerId: string,
    apiKey: string,
    premblyApiKey: string,
    premblyAppId: string,
    environment: 'sandbox' | 'production' = 'sandbox',
  ) {
    this.partnerId = partnerId;
    this.apiKey = apiKey;
    this.premblyApiKey = premblyApiKey;
    this.premblyAppId = premblyAppId;
    this.environment = environment;
  }

  private get smileBaseUrl(): string {
    return this.environment === 'production' ? SMILE_BASE_PRODUCTION : SMILE_BASE_SANDBOX;
  }

  // ── BVN verification ───────────────────────────────────────────────────────

  async verifyBvn(
    bvnHash: string,
    firstName: string,
    lastName: string,
    dob: string,
  ): Promise<KycVerificationResult> {
    try {
      const res = await fetch(`${this.smileBaseUrl}/id_verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partner_id: this.partnerId,
          api_key: this.apiKey,
          id_type: 'BVN',
          id_number: bvnHash,
          first_name: firstName,
          last_name: lastName,
          dob,
          country: 'NG',
        }),
      });

      if (!res.ok) {
        return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const verified = data.ResultCode === '1012';
      const result: KycVerificationResult = { verified, provider: 'smile_identity' };

      // matchScore — parse from ConfidenceValue (number or numeric string)
      const rawScore = typeof data.ConfidenceValue === 'number'
        ? data.ConfidenceValue
        : typeof data.ConfidenceValue === 'string'
          ? parseFloat(data.ConfidenceValue as string)
          : NaN;
      if (!isNaN(rawScore)) result.matchScore = rawScore;
      if (typeof data.ResultText === 'string') result.reason = data.ResultText;

      return result;
    } catch {
      return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
    }
  }

  // ── NIN verification ───────────────────────────────────────────────────────

  async verifyNin(
    ninHash: string,
    firstName: string,
    lastName: string,
  ): Promise<KycVerificationResult> {
    try {
      const res = await fetch(`${this.smileBaseUrl}/id_verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partner_id: this.partnerId,
          api_key: this.apiKey,
          id_type: 'NIN',
          id_number: ninHash,
          first_name: firstName,
          last_name: lastName,
          country: 'NG',
        }),
      });

      if (!res.ok) {
        return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const verified = data.ResultCode === '1012';
      const result: KycVerificationResult = { verified, provider: 'smile_identity' };

      const rawScore = typeof data.ConfidenceValue === 'number'
        ? data.ConfidenceValue
        : typeof data.ConfidenceValue === 'string'
          ? parseFloat(data.ConfidenceValue as string)
          : NaN;
      if (!isNaN(rawScore)) result.matchScore = rawScore;
      if (typeof data.ResultText === 'string') result.reason = data.ResultText;

      return result;
    } catch {
      return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
    }
  }

  // ── CAC verification (via Prembly) ─────────────────────────────────────────

  async verifyCac(
    rcNumber: string,
    businessName: string,
  ): Promise<KycVerificationResult> {
    try {
      const res = await fetch(PREMBLY_CAC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.premblyApiKey,
          'app-id': this.premblyAppId,
        },
        body: JSON.stringify({ rc_number: rcNumber }),
      });

      if (!res.ok) {
        return { verified: false, reason: 'provider_error', provider: 'prembly' };
      }

      const data = (await res.json()) as Record<string, unknown>;
      const companyData = data.data as Record<string, unknown> | undefined;
      const returnedName = typeof companyData?.company_name === 'string'
        ? companyData.company_name
        : '';

      const verified = returnedName.toLowerCase().includes(businessName.toLowerCase());

      return {
        verified,
        reason: verified
          ? 'Business name matched'
          : `Business name mismatch: returned '${returnedName}'`,
        provider: 'prembly',
      };
    } catch {
      return { verified: false, reason: 'provider_error', provider: 'prembly' };
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * createKycProvider — factory for the composite KYC provider.
 *
 * Returns a SmileIdentityProvider that handles BVN, NIN (Smile Identity)
 * and CAC (Prembly) from a single entry-point.
 *
 * @param smilePartnerId  - Smile Identity partner_id
 * @param smileApiKey     - Smile Identity api_key
 * @param premblyApiKey   - Prembly x-api-key
 * @param premblyAppId    - Prembly app-id
 * @param environment     - 'sandbox' (default) | 'production'
 */
export function createKycProvider(
  smilePartnerId: string,
  smileApiKey: string,
  premblyApiKey: string,
  premblyAppId: string,
  environment: 'sandbox' | 'production' = 'sandbox',
): IKycProvider {
  return new SmileIdentityProvider(
    smilePartnerId,
    smileApiKey,
    premblyApiKey,
    premblyAppId,
    environment,
  );
}
