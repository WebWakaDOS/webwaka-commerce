/**
 * VendorOnboardingWizard — 5-step self-service vendor registration
 *
 * Steps:
 *   1. Business profile  (name, category, description, phone)
 *   2. Personal identity (firstName, lastName, BVN → SHA-256, DOB)
 *   3. Bank account      (bank dropdown, account number → auto-verify)
 *   4. Business details  (RC number, CAC name, WhatsApp, logo, pickup address)
 *   5. Review & submit   → POST /vendor/register
 *
 * Invariants:
 *   - Offline-First: each step is persisted to Dexie onboardingState immediately
 *   - BVN is hashed client-side (SHA-256 via Web Crypto) — raw BVN never leaves device
 *   - Nigeria-First: Nigerian phone & state/LGA validation
 *   - Multi-tenant: tenantId from props
 */
import React, { useState, useEffect, useRef } from 'react';
import { getCommerceDB } from '../../core/offline/db';

// ─── Types ────────────────────────────────────────────────────────────────────

interface WizardData {
  businessName: string;
  category: string;
  description: string;
  phone: string;
  firstName: string;
  lastName: string;
  bvn: string;
  bvnHash: string;
  dob: string;
  accountNumber: string;
  bankCode: string;
  accountName: string;
  rcNumber: string;
  businessNameForCac: string;
  whatsapp: string;
  logoUrl: string;
  pickupStreet: string;
  pickupCity: string;
  pickupState: string;
  pickupLga: string;
}

const EMPTY_DATA: WizardData = {
  businessName: '', category: '', description: '', phone: '',
  firstName: '', lastName: '', bvn: '', bvnHash: '', dob: '',
  accountNumber: '', bankCode: '', accountName: '',
  rcNumber: '', businessNameForCac: '', whatsapp: '', logoUrl: '',
  pickupStreet: '', pickupCity: '', pickupState: '', pickupLga: '',
};

// ─── Nigeria data ─────────────────────────────────────────────────────────────

const NG_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa',
  'Benue', 'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti',
  'Enugu', 'FCT', 'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina',
  'Kebbi', 'Kogi', 'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo',
  'Osun', 'Oyo', 'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

const NG_BANKS: Array<{ code: string; name: string }> = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'EcoBank' },
  { code: '011', name: 'First Bank' },
  { code: '214', name: 'FCMB' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '058', name: 'GTBank' },
  { code: '030', name: 'Heritage Bank' },
  { code: '301', name: 'Jaiz Bank' },
  { code: '082', name: 'Keystone Bank' },
  { code: '526', name: 'Moniepoint MFB' },
  { code: '304', name: 'OPay' },
  { code: '076', name: 'Polaris Bank' },
  { code: '101', name: 'Providus Bank' },
  { code: '221', name: 'Stanbic IBTC' },
  { code: '232', name: 'Sterling Bank' },
  { code: '032', name: 'Union Bank' },
  { code: '033', name: 'UBA' },
  { code: '215', name: 'Unity Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '057', name: 'Zenith Bank' },
];

const CATEGORIES = [
  'Fashion & Apparel', 'Electronics', 'Food & Grocery', 'Health & Beauty',
  'Home & Living', 'Sports & Fitness', 'Books & Stationery', 'Baby & Kids',
  'Automotive', 'Agriculture', 'Services', 'Other',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sha256Hex(value: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function toE164(phone: string): string {
  const raw = phone.trim();
  if (raw.startsWith('+234')) return raw;
  if (raw.startsWith('0')) return `+234${raw.slice(1)}`;
  return raw;
}

// ─── Dexie persistence key ────────────────────────────────────────────────────

const DRAFT_VENDOR_ID = '__onboarding_draft__';

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  container: {
    maxWidth: 540,
    margin: '0 auto',
    padding: '16px',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize: 14,
    color: '#111',
  } as React.CSSProperties,
  card: {
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 12,
    padding: '24px 20px',
    marginBottom: 16,
  } as React.CSSProperties,
  progressBar: {
    display: 'flex',
    gap: 6,
    marginBottom: 24,
  } as React.CSSProperties,
  progressStep: (active: boolean, done: boolean): React.CSSProperties => ({
    flex: 1,
    height: 4,
    borderRadius: 2,
    background: done ? '#10b981' : active ? '#6366f1' : '#e5e7eb',
    transition: 'background 0.3s',
  }),
  heading: {
    fontSize: 18,
    fontWeight: 700,
    marginBottom: 4,
  } as React.CSSProperties,
  sub: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 20,
  } as React.CSSProperties,
  label: {
    display: 'block',
    fontWeight: 600,
    marginBottom: 4,
    fontSize: 13,
  } as React.CSSProperties,
  labelOpt: {
    display: 'block',
    fontWeight: 500,
    marginBottom: 4,
    fontSize: 13,
    color: '#6b7280',
  } as React.CSSProperties,
  input: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    fontSize: 14,
    marginBottom: 14,
    boxSizing: 'border-box',
    outline: 'none',
    background: '#fff',
  } as React.CSSProperties,
  select: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    fontSize: 14,
    marginBottom: 14,
    boxSizing: 'border-box',
    background: '#fff',
    cursor: 'pointer',
  } as React.CSSProperties,
  textarea: {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 8,
    fontSize: 14,
    marginBottom: 14,
    boxSizing: 'border-box',
    resize: 'vertical',
    minHeight: 72,
  } as React.CSSProperties,
  row: {
    display: 'flex',
    gap: 12,
  } as React.CSSProperties,
  btnPrimary: {
    display: 'block',
    width: '100%',
    padding: '12px',
    background: '#6366f1',
    color: '#fff',
    fontWeight: 700,
    fontSize: 15,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    marginTop: 4,
  } as React.CSSProperties,
  btnSecondary: {
    display: 'block',
    width: '100%',
    padding: '11px',
    background: '#fff',
    color: '#6366f1',
    fontWeight: 600,
    fontSize: 14,
    border: '1px solid #6366f1',
    borderRadius: 8,
    cursor: 'pointer',
    marginTop: 8,
  } as React.CSSProperties,
  btnGreen: {
    display: 'block',
    width: '100%',
    padding: '12px',
    background: '#10b981',
    color: '#fff',
    fontWeight: 700,
    fontSize: 15,
    border: 'none',
    borderRadius: 8,
    cursor: 'pointer',
    marginTop: 4,
  } as React.CSSProperties,
  errorBox: {
    background: '#fef2f2',
    border: '1px solid #fca5a5',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#b91c1c',
    fontSize: 13,
    marginBottom: 12,
  } as React.CSSProperties,
  infoBox: {
    background: '#eff6ff',
    border: '1px solid #93c5fd',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#1d4ed8',
    fontSize: 13,
    marginBottom: 12,
  } as React.CSSProperties,
  successBox: {
    background: '#f0fdf4',
    border: '1px solid #86efac',
    borderRadius: 8,
    padding: '10px 12px',
    color: '#166534',
    fontSize: 13,
    marginBottom: 12,
  } as React.CSSProperties,
  reviewRow: {
    display: 'flex',
    justifyContent: 'space-between',
    padding: '6px 0',
    borderBottom: '1px solid #f3f4f6',
    fontSize: 13,
  } as React.CSSProperties,
  reviewLabel: {
    color: '#6b7280',
    flexShrink: 0,
    marginRight: 8,
  } as React.CSSProperties,
  reviewValue: {
    fontWeight: 500,
    textAlign: 'right',
    wordBreak: 'break-all',
  } as React.CSSProperties,
};

// ─── Main component ───────────────────────────────────────────────────────────

export interface VendorOnboardingWizardProps {
  tenantId: string;
  apiBase?: string;
  onComplete?: (vendorId: string) => void;
}

export const VendorOnboardingWizard: React.FC<VendorOnboardingWizardProps> = ({
  tenantId,
  apiBase = '/api/multi-vendor',
  onComplete,
}) => {
  const [step, setStep] = useState(1);
  const [data, setData] = useState<WizardData>(EMPTY_DATA);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bankVerified, setBankVerified] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const TOTAL_STEPS = 5;

  // ── Restore draft from Dexie on mount ────────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      try {
        const offlineDb = getCommerceDB(tenantId);
        const draft = await offlineDb.onboardingState
          .where({ tenantId, vendorId: DRAFT_VENDOR_ID })
          .first();
        if (draft && mountedRef.current) {
          const saved = draft.data as { step?: number; form?: WizardData } | undefined;
          if (saved?.form) setData(saved.form);
          if (saved?.step && saved.step > 1) setStep(saved.step);
        }
      } catch { /* IndexedDB not available — continue without draft */ }
    })();
    return () => { mountedRef.current = false; };
  }, [tenantId]);

  // ── Persist step + form data to Dexie ────────────────────────────────────
  const persistDraft = async (nextStep: number, form: WizardData) => {
    try {
      const offlineDb = getCommerceDB(tenantId);
      const existing = await offlineDb.onboardingState
        .where({ tenantId, vendorId: DRAFT_VENDOR_ID })
        .first();
      const now = Date.now();
      const payload = { step: nextStep, form: { ...form, bvn: '' } }; // never persist raw BVN
      if (existing?.id !== undefined) {
        await offlineDb.onboardingState.update(existing.id, { step: String(nextStep), data: payload, updatedAt: now });
      } else {
        await offlineDb.onboardingState.add({ tenantId, vendorId: DRAFT_VENDOR_ID, step: String(nextStep), data: payload, updatedAt: now });
      }
    } catch { /* non-fatal */ }
  };

  // ── Shared field update helper ────────────────────────────────────────────
  const set = (field: keyof WizardData) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    setData(d => ({ ...d, [field]: e.target.value }));
    setError(null);
  };

  const clearDraft = async () => {
    try {
      const offlineDb = getCommerceDB(tenantId);
      await offlineDb.onboardingState.where({ tenantId, vendorId: DRAFT_VENDOR_ID }).delete();
    } catch { /* non-fatal */ }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 1 — Business profile
  // ─────────────────────────────────────────────────────────────────────────
  const step1Next = async () => {
    if (!data.businessName.trim()) return setError('Business name is required');
    if (!data.phone.trim()) return setError('Phone number is required');
    const phoneRaw = data.phone.trim();
    if (!/^\+234[0-9]{10}$/.test(phoneRaw) && !/^0[0-9]{10}$/.test(phoneRaw)) {
      return setError('Enter a valid Nigerian phone number (e.g. 08012345678)');
    }
    await persistDraft(2, data);
    setStep(2);
    setError(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 2 — Personal identity (BVN hashed client-side)
  // ─────────────────────────────────────────────────────────────────────────
  const step2Next = async () => {
    if (!data.firstName.trim()) return setError('First name is required');
    if (!data.lastName.trim()) return setError('Last name is required');
    if (!data.bvn.trim()) return setError('BVN is required');
    if (!/^\d{11}$/.test(data.bvn.trim())) return setError('BVN must be 11 digits');
    if (!data.dob.trim()) return setError('Date of birth is required');

    setBusy(true);
    try {
      const hash = await sha256Hex(data.bvn.trim());
      const next = { ...data, bvnHash: hash, bvn: '' }; // clear raw BVN after hashing
      setData(next);
      await persistDraft(3, next);
      setStep(3);
      setError(null);
    } catch {
      setError('Failed to hash BVN. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 3 — Bank account (auto-verify via Paystack resolve)
  // ─────────────────────────────────────────────────────────────────────────
  const verifyBank = async () => {
    if (!data.accountNumber.trim()) return setError('Account number is required');
    if (!/^\d{10}$/.test(data.accountNumber.trim())) return setError('Account number must be 10 digits');
    if (!data.bankCode) return setError('Please select a bank');

    setBusy(true);
    setError(null);
    setBankVerified(false);
    try {
      const res = await fetch(
        `${apiBase}/verify-bank-account?accountNumber=${encodeURIComponent(data.accountNumber.trim())}&bankCode=${encodeURIComponent(data.bankCode)}`,
        { headers: { 'x-tenant-id': tenantId } },
      );
      const json = await res.json() as { valid?: boolean; accountName?: string; error?: string };
      if (json.valid && json.accountName) {
        setData(d => ({ ...d, accountName: json.accountName! }));
        setBankVerified(true);
      } else {
        setError(json.error ?? 'Could not verify account. Check details and retry.');
      }
    } catch {
      setError('Bank verification service unavailable. You can continue and verify later.');
    } finally {
      setBusy(false);
    }
  };

  const step3Next = async () => {
    if (!bankVerified && !data.accountName) return setError('Please verify your bank account first');
    const next = { ...data };
    await persistDraft(4, next);
    setStep(4);
    setError(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 4 — Business registration details
  // ─────────────────────────────────────────────────────────────────────────
  const step4Next = async () => {
    if (!data.pickupState) return setError('Pickup state is required');
    const next = { ...data };
    await persistDraft(5, next);
    setStep(5);
    setError(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // STEP 5 — Review & submit
  // ─────────────────────────────────────────────────────────────────────────
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = {
        businessName: data.businessName.trim(),
        category: data.category || undefined,
        description: data.description.trim() || undefined,
        phone: toE164(data.phone),
        firstName: data.firstName.trim(),
        lastName: data.lastName.trim(),
        bvnHash: data.bvnHash,
        dob: data.dob.trim(),
        accountNumber: data.accountNumber.trim(),
        bankCode: data.bankCode,
        accountName: data.accountName.trim(),
        rcNumber: data.rcNumber.trim() || undefined,
        businessNameForCac: data.businessNameForCac.trim() || data.businessName.trim(),
        whatsapp: data.whatsapp.trim() || undefined,
        logoUrl: data.logoUrl.trim() || undefined,
        pickupAddress: {
          street: data.pickupStreet.trim(),
          city: data.pickupCity.trim(),
          state: data.pickupState,
          lga: data.pickupLga.trim(),
        },
      };

      const res = await fetch(`${apiBase}/vendor/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
        },
        body: JSON.stringify(payload),
      });
      const json = await res.json() as { success?: boolean; data?: { vendor_id: string }; error?: string };
      if (res.ok && json.success && json.data?.vendor_id) {
        await clearDraft();
        setVendorId(json.data.vendor_id);
        setSubmitted(true);
        onComplete?.(json.data.vendor_id);
      } else {
        setError(json.error ?? 'Registration failed. Please try again.');
      }
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  if (submitted) {
    return (
      <div style={s.container}>
        <div style={s.card}>
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
            <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Application Submitted!</div>
            <div style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.6 }}>
              Your seller account application has been submitted successfully.
              You will receive a WhatsApp notification with your verification status shortly.
            </div>
            {vendorId && (
              <div style={{ ...s.infoBox, marginTop: 16, textAlign: 'left' }}>
                Application reference: <strong>{vendorId}</strong>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const stepLabels = ['Business', 'Identity', 'Bank', 'Details', 'Review'];

  return (
    <div style={s.container}>
      {/* Progress */}
      <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
        {stepLabels.map((label, i) => (
          <span key={label} style={{ fontSize: 11, color: i + 1 <= step ? '#6366f1' : '#9ca3af', fontWeight: i + 1 === step ? 700 : 400 }}>
            {label}
          </span>
        ))}
      </div>
      <div style={s.progressBar}>
        {stepLabels.map((_, i) => (
          <div key={i} style={s.progressStep(i + 1 === step, i + 1 < step)} />
        ))}
      </div>

      {error && <div style={s.errorBox}>{error}</div>}

      {/* ── Step 1: Business Profile ── */}
      {step === 1 && (
        <div style={s.card}>
          <div style={s.heading}>Business Profile</div>
          <div style={s.sub}>Tell us about your business</div>

          <label style={s.label}>Business Name *</label>
          <input style={s.input} placeholder="e.g. Adaeze Fashion Hub" value={data.businessName} onChange={set('businessName')} />

          <label style={s.label}>Category *</label>
          <select style={s.select} value={data.category} onChange={set('category')}>
            <option value="">Select category</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>

          <label style={s.labelOpt}>Description (optional)</label>
          <textarea style={s.textarea} placeholder="Briefly describe what you sell" value={data.description} onChange={set('description')} />

          <label style={s.label}>Phone Number *</label>
          <input style={s.input} type="tel" placeholder="08012345678" value={data.phone} onChange={set('phone')} />

          <button style={s.btnPrimary} onClick={step1Next}>Continue</button>
        </div>
      )}

      {/* ── Step 2: Personal Identity ── */}
      {step === 2 && (
        <div style={s.card}>
          <div style={s.heading}>Personal Identity</div>
          <div style={s.sub}>For KYC verification — BVN is hashed on your device and never sent in plain text</div>

          <div style={s.row}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>First Name *</label>
              <input style={s.input} placeholder="Chidi" value={data.firstName} onChange={set('firstName')} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Last Name *</label>
              <input style={s.input} placeholder="Okafor" value={data.lastName} onChange={set('lastName')} />
            </div>
          </div>

          <label style={s.label}>BVN (Bank Verification Number) *</label>
          <input
            style={s.input}
            type="password"
            inputMode="numeric"
            placeholder="11-digit BVN"
            value={data.bvn}
            onChange={set('bvn')}
            maxLength={11}
          />
          <div style={{ ...s.infoBox, marginTop: -10, marginBottom: 14 }}>
            Your BVN is hashed locally before transmission. We never store or transmit your raw BVN.
          </div>

          <label style={s.label}>Date of Birth *</label>
          <input style={s.input} type="date" value={data.dob} onChange={set('dob')} max={new Date(Date.now() - 18 * 365.25 * 86400000).toISOString().split('T')[0]} />

          <div style={s.row}>
            <button style={{ ...s.btnSecondary, marginTop: 0 }} onClick={() => { setStep(1); setError(null); }}>Back</button>
            <button style={{ ...s.btnPrimary, marginTop: 0 }} onClick={step2Next} disabled={busy}>
              {busy ? 'Processing…' : 'Continue'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Bank Account ── */}
      {step === 3 && (
        <div style={s.card}>
          <div style={s.heading}>Bank Account</div>
          <div style={s.sub}>For receiving payments — account must be in your business name</div>

          <label style={s.label}>Bank *</label>
          <select style={s.select} value={data.bankCode} onChange={set('bankCode')}>
            <option value="">Select bank</option>
            {NG_BANKS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>

          <label style={s.label}>Account Number *</label>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'flex-start' }}>
            <input
              style={{ ...s.input, marginBottom: 0, flex: 1 }}
              type="text"
              inputMode="numeric"
              placeholder="0123456789"
              value={data.accountNumber}
              onChange={e => { set('accountNumber')(e); setBankVerified(false); setData(d => ({ ...d, accountName: '' })); }}
              maxLength={10}
            />
            <button
              style={{ padding: '10px 14px', background: '#6366f1', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}
              onClick={verifyBank}
              disabled={busy}
            >
              {busy ? '…' : 'Verify'}
            </button>
          </div>

          {bankVerified && data.accountName && (
            <div style={s.successBox}>
              Account verified: <strong>{data.accountName}</strong>
            </div>
          )}

          <div style={s.row}>
            <button style={{ ...s.btnSecondary, marginTop: 0 }} onClick={() => { setStep(2); setError(null); }}>Back</button>
            <button style={{ ...s.btnPrimary, marginTop: 0 }} onClick={step3Next} disabled={busy}>Continue</button>
          </div>
        </div>
      )}

      {/* ── Step 4: Business Details ── */}
      {step === 4 && (
        <div style={s.card}>
          <div style={s.heading}>Business Details</div>
          <div style={s.sub}>Registration info and pickup address (all optional except State)</div>

          <label style={s.labelOpt}>RC Number (CAC) — optional</label>
          <input style={s.input} placeholder="RC1234567" value={data.rcNumber} onChange={set('rcNumber')} />

          <label style={s.labelOpt}>Registered Business Name for CAC — optional</label>
          <input style={s.input} placeholder="Exact name on CAC certificate" value={data.businessNameForCac} onChange={set('businessNameForCac')} />

          <label style={s.labelOpt}>WhatsApp Number — optional</label>
          <input style={s.input} type="tel" placeholder="08012345678" value={data.whatsapp} onChange={set('whatsapp')} />

          <label style={s.labelOpt}>Logo URL — optional</label>
          <input style={s.input} type="url" placeholder="https://..." value={data.logoUrl} onChange={set('logoUrl')} />

          <div style={{ fontWeight: 700, fontSize: 13, margin: '4px 0 10px' }}>Pickup Address</div>
          <div style={s.row}>
            <div style={{ flex: 1 }}>
              <label style={s.labelOpt}>State *</label>
              <select style={s.select} value={data.pickupState} onChange={set('pickupState')}>
                <option value="">Select state</option>
                {NG_STATES.map(st => <option key={st} value={st}>{st}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.labelOpt}>LGA</label>
              <input style={s.input} placeholder="Local Govt Area" value={data.pickupLga} onChange={set('pickupLga')} />
            </div>
          </div>

          <label style={s.labelOpt}>City</label>
          <input style={s.input} placeholder="Ikeja" value={data.pickupCity} onChange={set('pickupCity')} />

          <label style={s.labelOpt}>Street Address</label>
          <input style={s.input} placeholder="12 Broad Street" value={data.pickupStreet} onChange={set('pickupStreet')} />

          <div style={s.row}>
            <button style={{ ...s.btnSecondary, marginTop: 0 }} onClick={() => { setStep(3); setError(null); }}>Back</button>
            <button style={{ ...s.btnPrimary, marginTop: 0 }} onClick={step4Next}>Continue</button>
          </div>
        </div>
      )}

      {/* ── Step 5: Review & Submit ── */}
      {step === 5 && (
        <div style={s.card}>
          <div style={s.heading}>Review & Submit</div>
          <div style={s.sub}>Please confirm your details before submitting</div>

          {[
            ['Business Name', data.businessName],
            ['Category', data.category || '—'],
            ['Phone', toE164(data.phone)],
            ['Name', `${data.firstName} ${data.lastName}`],
            ['Date of Birth', data.dob],
            ['BVN', data.bvnHash ? `••••••••••••••••••••${data.bvnHash.slice(-8)}` : '—'],
            ['Bank', NG_BANKS.find(b => b.code === data.bankCode)?.name ?? data.bankCode],
            ['Account Number', data.accountNumber],
            ['Account Name', data.accountName || '—'],
            ['RC Number', data.rcNumber || '—'],
            ['WhatsApp', data.whatsapp || '—'],
            ['Pickup State', data.pickupState || '—'],
          ].map(([label, value]) => (
            <div key={label} style={s.reviewRow}>
              <span style={s.reviewLabel}>{label}</span>
              <span style={s.reviewValue}>{value}</span>
            </div>
          ))}

          <div style={{ marginTop: 16 }}>
            <button style={s.btnGreen} onClick={submit} disabled={busy}>
              {busy ? 'Submitting…' : 'Submit Application'}
            </button>
            <button style={s.btnSecondary} onClick={() => { setStep(4); setError(null); }}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default VendorOnboardingWizard;
