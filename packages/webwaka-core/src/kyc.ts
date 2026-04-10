/**
 * WebWaka — KYC Verification Providers
 *
 * Provides SmileIdentityProvider (BVN/NIN via Smile Identity, CAC via Prembly)
 * and the createKycProvider factory.
 *
 * Nigeria-First: BVN and NIN via Smile Identity, CAC via Prembly.
 * Sandbox uses testapi.smileidentity.com; production uses api.smileidentity.com.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KycVerificationResult {
  verified: boolean;
  matchScore?: number;
  reason?: string;
  provider: string;
}

export interface IKycProvider {
  verifyBvn(bvnNumber: string, firstName: string, lastName: string, dob: string): Promise<KycVerificationResult>;
  verifyNin(nin: string, firstName: string, lastName: string): Promise<KycVerificationResult>;
  verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult>;
}

// ─── SmileIdentityProvider ────────────────────────────────────────────────────

export class SmileIdentityProvider implements IKycProvider {
  private readonly smileBaseUrl: string;
  private readonly partnerId: string;
  private readonly apiKey: string;
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
    this.smileBaseUrl = environment === 'production'
      ? 'https://api.smileidentity.com/v1'
      : 'https://testapi.smileidentity.com/v1';
  }

  async verifyBvn(
    bvnNumber: string,
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
          id_number: bvnNumber,
          country: 'NG',
          first_name: firstName,
          last_name: lastName,
          dob,
        }),
      });

      if (!res.ok) {
        return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
      }

      const data = await res.json() as {
        ResultCode?: string;
        ResultText?: string;
        ConfidenceValue?: string | number;
      };

      const verified = data.ResultCode === '1012';
      const matchScore = data.ConfidenceValue !== undefined
        ? parseFloat(String(data.ConfidenceValue))
        : undefined;

      return {
        verified,
        provider: 'smile_identity',
        reason: data.ResultText,
        matchScore,
      };
    } catch (err) {
      return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
    }
  }

  async verifyNin(
    nin: string,
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
          id_number: nin,
          country: 'NG',
          first_name: firstName,
          last_name: lastName,
        }),
      });

      if (!res.ok) {
        return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
      }

      const data = await res.json() as {
        ResultCode?: string;
        ResultText?: string;
        ConfidenceValue?: string | number;
      };

      const verified = data.ResultCode === '1012';
      const matchScore = data.ConfidenceValue !== undefined
        ? parseFloat(String(data.ConfidenceValue))
        : undefined;

      return {
        verified,
        provider: 'smile_identity',
        reason: data.ResultText,
        matchScore,
      };
    } catch (err) {
      return { verified: false, reason: 'provider_error', provider: 'smile_identity' };
    }
  }

  async verifyCac(rcNumber: string, businessName: string): Promise<KycVerificationResult> {
    try {
      const res = await fetch('https://api.prembly.com/identitypass/verification/cac', {
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

      const data = await res.json() as {
        status?: boolean;
        data?: { company_name?: string };
      };

      if (!data.status || !data.data?.company_name) {
        return { verified: false, reason: 'provider_error', provider: 'prembly' };
      }

      const registeredName = data.data.company_name;
      const matches = registeredName.toLowerCase().includes(businessName.toLowerCase());

      if (matches) {
        return { verified: true, provider: 'prembly', reason: `Matched: ${registeredName}` };
      }

      return {
        verified: false,
        provider: 'prembly',
        reason: `name mismatch: registered as ${registeredName}`,
      };
    } catch (err) {
      return { verified: false, reason: 'provider_error', provider: 'prembly' };
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createKycProvider(
  partnerId: string,
  apiKey: string,
  premblyApiKey: string,
  premblyAppId: string,
  environment: 'sandbox' | 'production' = 'sandbox',
): IKycProvider {
  return new SmileIdentityProvider(partnerId, apiKey, premblyApiKey, premblyAppId, environment);
}
