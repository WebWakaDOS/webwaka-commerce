import React, { useState, useEffect } from 'react';

// Mock types for UI demonstration
type Role = 'admin' | 'cashier' | 'vendor';
type TenantType = 'retail' | 'single_vendor' | 'multi_vendor' | 'vendor';

interface User {
  id: string;
  name: string;
  role: Role;
  tenantId: string;
}

interface TenantConfig {
  id: string;
  type: TenantType;
  name: string;
  syncPreferences: {
    sync_pos_to_single_vendor: boolean;
    sync_pos_to_multi_vendor: boolean;
    sync_single_vendor_to_multi_vendor: boolean;
    conflict_resolution: 'last_write_wins' | 'manual';
  };
}

// --- Shared Components ---

const Card: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px', marginBottom: '16px', backgroundColor: 'white' }}>
    <h3 style={{ marginTop: 0, borderBottom: '1px solid #e2e8f0', paddingBottom: '8px' }}>{title}</h3>
    {children}
  </div>
);

const Button: React.FC<{ onClick: () => void; children: React.ReactNode; primary?: boolean }> = ({ onClick, children, primary }) => (
  <button 
    onClick={onClick}
    style={{
      padding: '8px 16px',
      backgroundColor: primary ? '#2563eb' : '#f1f5f9',
      color: primary ? 'white' : '#334155',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontWeight: 'bold'
    }}
  >
    {children}
  </button>
);

// --- Admin Dashboards ---

export const RetailAdminDashboard: React.FC<{ user: User; config: TenantConfig }> = ({ user, config }) => {
  const [syncConfig, setSyncConfig] = useState(config.syncPreferences);

  const handleSaveSync = () => {
    alert('Sync preferences saved to Tenant-as-Code registry');
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Retail POS & Storefront Admin</h2>
      <p>Welcome, {user.name} ({user.role}) | Tenant: {config.name}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <Card title="Today's Sales (POS)">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>₦45,000</div>
          <p style={{ margin: '4px 0', color: '#64748b' }}>12 Transactions</p>
        </Card>
        <Card title="Today's Sales (Online)">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>₦12,500</div>
          <p style={{ margin: '4px 0', color: '#64748b' }}>3 Orders</p>
        </Card>
      </div>

      <Card title="Inventory Sync Preferences">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input 
              type="checkbox" 
              checked={syncConfig.sync_pos_to_single_vendor}
              onChange={(e) => setSyncConfig({...syncConfig, sync_pos_to_single_vendor: e.target.checked})}
            />
            Sync POS inventory to Single Vendor Storefront automatically
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <input 
              type="checkbox" 
              checked={syncConfig.sync_pos_to_multi_vendor}
              onChange={(e) => setSyncConfig({...syncConfig, sync_pos_to_multi_vendor: e.target.checked})}
            />
            Sync POS inventory to Multi Vendor Marketplace automatically
          </label>
          <div style={{ marginTop: '8px' }}>
            <Button primary onClick={handleSaveSync}>Save Preferences</Button>
          </div>
        </div>
      </Card>

      <Card title="Staff Management (RBAC)">
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '8px' }}>Name</th>
              <th style={{ padding: '8px' }}>Role</th>
              <th style={{ padding: '8px' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '8px' }}>Admin User</td>
              <td style={{ padding: '8px' }}><span style={{ background: '#dbeafe', color: '#1e40af', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>Admin</span></td>
              <td style={{ padding: '8px' }}><Button onClick={() => {}}>Edit</Button></td>
            </tr>
            <tr>
              <td style={{ padding: '8px' }}>Store Cashier</td>
              <td style={{ padding: '8px' }}><span style={{ background: '#fef3c7', color: '#1e3a8a', padding: '2px 6px', borderRadius: '4px', fontSize: '12px' }}>Cashier</span></td>
              <td style={{ padding: '8px' }}><Button onClick={() => {}}>Edit</Button></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
};

// ── Commission Management card (MV-E02) ─────────────────────────────────────

interface CommissionRule {
  id?: string;
  vendorId?: string | null;
  category?: string | null;
  rateBps: number;
  effectiveFrom?: string;
  effectiveUntil?: string | null;
}

const CommissionManagement: React.FC<{ tenantId: string }> = ({ tenantId }) => {
  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState<{ vendorId: string; category: string; ratePct: string; effectiveFrom: string }>({
    vendorId: '', category: '', ratePct: '10', effectiveFrom: new Date().toISOString().slice(0, 10),
  });

  const loadRules = () => {
    setLoading(true);
    fetch('/api/multi-vendor/admin/commission-rules', { headers: { 'x-tenant-id': tenantId } })
      .then((r) => r.json() as Promise<{ success: boolean; data?: CommissionRule[] }>)
      .then((j) => { if (j.success) setRules(j.data ?? []); })
      .catch(() => setMsg('Failed to load rules.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadRules(); }, []);

  const handleAddRule = () => {
    const rateBps = Math.round(parseFloat(form.ratePct) * 100);
    if (isNaN(rateBps) || rateBps < 0 || rateBps > 10000) { setMsg('Rate must be 0–100%.'); return; }
    setMsg(null);
    fetch('/api/multi-vendor/admin/commission-rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId },
      body: JSON.stringify({
        vendorId: form.vendorId.trim() || null,
        category: form.category.trim() || null,
        rateBps,
        effectiveFrom: form.effectiveFrom,
      }),
    })
      .then((r) => r.json() as Promise<{ success: boolean; error?: string }>)
      .then((j) => {
        if (j.success) { setMsg('✓ Rule saved.'); loadRules(); }
        else setMsg(`Error: ${j.error ?? 'Unknown'}`);
      })
      .catch(() => setMsg('Network error.'));
  };

  return (
    <div>
      {msg && (
        <div style={{ padding: '6px 10px', borderRadius: '4px', marginBottom: '10px', fontSize: '13px', background: msg.startsWith('✓') ? '#d1fae5' : '#fee2e2', color: msg.startsWith('✓') ? '#065f46' : '#dc2626' }}>
          {msg}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: '8px', marginBottom: '12px', alignItems: 'end' }}>
        <div>
          <label style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Vendor ID (optional)</label>
          <input value={form.vendorId} onChange={(e) => setForm({ ...form, vendorId: e.target.value })} placeholder="All vendors" style={{ width: '100%', padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Category (optional)</label>
          <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="All categories" style={{ width: '100%', padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Rate (%)</label>
          <input type="number" min={0} max={100} step={0.5} value={form.ratePct} onChange={(e) => setForm({ ...form, ratePct: e.target.value })} style={{ width: '100%', padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }} />
        </div>
        <div>
          <label style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '2px' }}>Effective From</label>
          <input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} style={{ width: '100%', padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' }} />
        </div>
        <Button primary onClick={handleAddRule}>Add Rule</Button>
      </div>

      {loading ? <p style={{ color: '#64748b', fontSize: '13px' }}>Loading rules…</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              {['Vendor', 'Category', 'Rate', 'Effective From', 'Until'].map((h) => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr><td colSpan={5} style={{ padding: '8px', color: '#94a3b8', textAlign: 'center' }}>No rules — default 10% applies.</td></tr>
            ) : rules.map((r, i) => (
              <tr key={r.id ?? i} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '12px' }}>{r.vendorId ?? <span style={{ color: '#94a3b8' }}>All</span>}</td>
                <td style={{ padding: '6px 8px' }}>{r.category ?? <span style={{ color: '#94a3b8' }}>All</span>}</td>
                <td style={{ padding: '6px 8px', fontWeight: 600, color: '#2563eb' }}>{(r.rateBps / 100).toFixed(1)}%</td>
                <td style={{ padding: '6px 8px', fontSize: '12px' }}>{r.effectiveFrom ?? '—'}</td>
                <td style={{ padding: '6px 8px', fontSize: '12px', color: '#94a3b8' }}>{r.effectiveUntil ?? 'Open'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ── Review Moderation (SV-E07) ───────────────────────────────────────────────

interface PendingReview {
  id: string;
  product_id: string;
  rating: number;
  body: string | null;
  review_text: string | null;
  customer_phone: string | null;
  created_at: number;
}

const ReviewModeration: React.FC<{ tenantId: string; adminKey: string }> = ({ tenantId, adminKey }) => {
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const loadReviews = () => {
    setLoading(true);
    fetch('/api/single-vendor/admin/reviews?status=PENDING', {
      headers: { 'x-tenant-id': tenantId, 'x-admin-key': adminKey },
    })
      .then((r) => r.json() as Promise<{ success: boolean; data?: PendingReview[] }>)
      .then((j) => { if (j.success) setReviews(j.data ?? []); })
      .catch(() => setMsg('Failed to load reviews.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadReviews(); }, []);

  const moderate = (id: string, status: 'APPROVED' | 'REJECTED') => {
    fetch(`/api/single-vendor/admin/reviews/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-admin-key': adminKey },
      body: JSON.stringify({ status }),
    })
      .then((r) => r.json() as Promise<{ success: boolean; error?: string }>)
      .then((j) => {
        if (j.success) { setMsg(`Review ${status.toLowerCase()}.`); loadReviews(); }
        else setMsg(`Error: ${j.error ?? 'Unknown'}`);
      })
      .catch(() => setMsg('Network error.'));
  };

  const stars = (rating: number) => '★'.repeat(rating) + '☆'.repeat(5 - rating);

  return (
    <div>
      {msg && (
        <div style={{ padding: '6px 10px', borderRadius: '4px', marginBottom: '10px', fontSize: '13px', background: msg.startsWith('Review') ? '#d1fae5' : '#fee2e2', color: msg.startsWith('Review') ? '#065f46' : '#dc2626' }}>
          {msg}
        </div>
      )}
      {loading ? <p style={{ color: '#64748b', fontSize: '13px' }}>Loading pending reviews…</p> : reviews.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center' }}>No pending reviews.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              {['Product', 'Rating', 'Review', 'Customer', 'Actions'].map((h) => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reviews.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '11px' }}>{r.product_id.slice(-8)}</td>
                <td style={{ padding: '6px 8px', color: '#f59e0b', fontSize: '14px' }}>{stars(r.rating)}</td>
                <td style={{ padding: '6px 8px', maxWidth: '250px' }}>{r.body ?? r.review_text ?? <span style={{ color: '#94a3b8' }}>No text</span>}</td>
                <td style={{ padding: '6px 8px', color: '#64748b', fontSize: '12px' }}>{r.customer_phone ?? '—'}</td>
                <td style={{ padding: '6px 8px', display: 'flex', gap: '6px' }}>
                  <button onClick={() => moderate(r.id, 'APPROVED')} style={{ padding: '4px 10px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Approve</button>
                  <button onClick={() => moderate(r.id, 'REJECTED')} style={{ padding: '4px 10px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>Reject</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ── Dispute Management (MV-E08) ───────────────────────────────────────────────

interface Dispute {
  id: string;
  order_id: string;
  reporter_id: string;
  reporter_role: string;
  category: string;
  description: string;
  evidence_urls_json: string | null;
  status: string;
  resolution: string | null;
  created_at: number;
}

const DisputeManagement: React.FC<{ tenantId: string; adminKey: string }> = ({ tenantId, adminKey }) => {
  const [tab, setTab] = useState<'OPEN' | 'UNDER_REVIEW' | 'RESOLVED'>('OPEN');
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [selected, setSelected] = useState<Dispute | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState('');

  const loadDisputes = () => {
    setLoading(true);
    fetch(`/api/multi-vendor/admin/disputes?status=${tab}`, {
      headers: { 'x-tenant-id': tenantId, 'x-admin-key': adminKey },
    })
      .then((r) => r.json() as Promise<{ success: boolean; data?: Dispute[] }>)
      .then((j) => { if (j.success) setDisputes(j.data ?? []); })
      .catch(() => setMsg('Failed to load disputes.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadDisputes(); setSelected(null); }, [tab]);

  const setUnderReview = (id: string) => {
    fetch(`/api/multi-vendor/admin/disputes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-admin-key': adminKey },
      body: JSON.stringify({ status: 'UNDER_REVIEW' }),
    })
      .then((r) => r.json() as Promise<{ success: boolean; error?: string }>)
      .then((j) => { if (j.success) { setMsg('Marked as Under Review.'); loadDisputes(); } else setMsg(`Error: ${j.error}`); })
      .catch(() => setMsg('Network error.'));
  };

  const resolve = (id: string, resolution: string, amountKobo?: number) => {
    fetch(`/api/multi-vendor/admin/disputes/${id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-admin-key': adminKey },
      body: JSON.stringify({ resolution, ...(amountKobo ? { amountKobo } : {}) }),
    })
      .then((r) => r.json() as Promise<{ success: boolean; error?: string }>)
      .then((j) => { if (j.success) { setMsg(`Resolved: ${resolution}`); loadDisputes(); setSelected(null); } else setMsg(`Error: ${j.error}`); })
      .catch(() => setMsg('Network error.'));
  };

  const tabStyle = (t: string) => ({
    padding: '8px 16px', borderRadius: '4px 4px 0 0', border: 'none', cursor: 'pointer',
    background: tab === t ? '#2563eb' : '#f1f5f9', color: tab === t ? 'white' : '#334155',
    fontWeight: tab === t ? 'bold' as const : 'normal' as const, fontSize: '13px',
  });

  return (
    <div>
      {msg && (
        <div style={{ padding: '6px 10px', borderRadius: '4px', marginBottom: '10px', fontSize: '13px', background: msg.startsWith('Error') ? '#fee2e2' : '#d1fae5', color: msg.startsWith('Error') ? '#dc2626' : '#065f46' }}>
          {msg}
        </div>
      )}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '12px' }}>
        {(['OPEN', 'UNDER_REVIEW', 'RESOLVED'] as const).map((t) => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t.replace('_', ' ')}</button>
        ))}
      </div>

      {selected ? (
        <div style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '16px' }}>
          <button onClick={() => setSelected(null)} style={{ marginBottom: '12px', background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: '13px' }}>← Back to list</button>
          <h4 style={{ margin: '0 0 8px' }}>Dispute: {selected.id}</h4>
          <p style={{ margin: '4px 0', fontSize: '13px' }}><strong>Order:</strong> {selected.order_id}</p>
          <p style={{ margin: '4px 0', fontSize: '13px' }}><strong>Reporter:</strong> {selected.reporter_role} ({selected.reporter_id.slice(-8)})</p>
          <p style={{ margin: '4px 0', fontSize: '13px' }}><strong>Category:</strong> {selected.category}</p>
          <p style={{ margin: '4px 0', fontSize: '13px' }}><strong>Description:</strong> {selected.description}</p>
          {selected.evidence_urls_json && (
            <div style={{ marginTop: '8px' }}>
              <strong style={{ fontSize: '13px' }}>Evidence:</strong>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '4px' }}>
                {(JSON.parse(selected.evidence_urls_json) as string[]).map((url, i) => (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#2563eb' }}>Image {i + 1}</a>
                ))}
              </div>
            </div>
          )}
          {selected.status !== 'RESOLVED' && (
            <div style={{ display: 'flex', gap: '8px', marginTop: '16px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => setUnderReview(selected.id)} style={{ padding: '6px 12px', background: '#f59e0b', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Under Review</button>
              <button onClick={() => resolve(selected.id, 'FULL_REFUND')} style={{ padding: '6px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Full Refund</button>
              <button onClick={() => resolve(selected.id, 'REPLACEMENT')} style={{ padding: '6px 12px', background: '#2563eb', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Replacement</button>
              <input
                type="number"
                placeholder="Amount (kobo)"
                value={partialAmount}
                onChange={(e) => setPartialAmount(e.target.value)}
                style={{ padding: '6px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', width: '140px' }}
              />
              <button onClick={() => resolve(selected.id, 'PARTIAL_REFUND', Number(partialAmount))} style={{ padding: '6px 12px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}>Partial Refund</button>
            </div>
          )}
        </div>
      ) : loading ? <p style={{ color: '#64748b', fontSize: '13px' }}>Loading disputes…</p> : disputes.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: '13px', textAlign: 'center' }}>No {tab.toLowerCase().replace('_', ' ')} disputes.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              {['ID', 'Order', 'Category', 'Reporter', 'Created', ''].map((h) => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {disputes.map((d) => (
              <tr key={d.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '11px' }}>{d.id.slice(-10)}</td>
                <td style={{ padding: '6px 8px', fontFamily: 'monospace', fontSize: '11px' }}>{d.order_id.slice(-10)}</td>
                <td style={{ padding: '6px 8px' }}>{d.category}</td>
                <td style={{ padding: '6px 8px', fontSize: '12px', color: '#64748b' }}>{d.reporter_role}</td>
                <td style={{ padding: '6px 8px', fontSize: '12px', color: '#64748b' }}>{new Date(d.created_at).toLocaleDateString()}</td>
                <td style={{ padding: '6px 8px' }}><button onClick={() => setSelected(d)} style={{ padding: '4px 10px', background: '#f1f5f9', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}>View</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ── ThemeEditor — Storefront Branding (SV-E09 / P12) ─────────────────────────
const ThemeEditor: React.FC<{ tenantId: string; adminKey: string }> = ({ tenantId, adminKey }) => {
  const [primaryColor, setPrimaryColor] = useState('#2563eb');
  const [accentColor, setAccentColor] = useState('#16a34a');
  const [fontFamily, setFontFamily] = useState('Inter, system-ui, sans-serif');
  const [heroImageUrl, setHeroImageUrl] = useState('');
  const [announcementBar, setAnnouncementBar] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/single-vendor/admin/tenant/branding', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-tenant-id': tenantId,
          'x-admin-key': adminKey,
          'x-role': 'TENANT_ADMIN',
        },
        body: JSON.stringify({ primaryColor, accentColor, fontFamily, heroImageUrl, announcementBar }),
      });
      const json = await res.json() as { success: boolean; error?: string };
      setMsg(json.success ? '✓ Theme saved' : `Error: ${json.error ?? 'Unknown'}`);
    } catch (e) {
      setMsg(`Error: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { width: '100%', padding: '6px 10px', border: '1px solid #e2e8f0', borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box' as const, marginBottom: '10px' };
  const labelStyle = { fontSize: '12px', color: '#374151', fontWeight: 600 as const, display: 'block' as const, marginBottom: '2px' };

  return (
    <div>
      {msg && (
        <div style={{ padding: '6px 10px', borderRadius: '4px', marginBottom: '10px', fontSize: '13px', background: msg.startsWith('Error') ? '#fee2e2' : '#d1fae5', color: msg.startsWith('Error') ? '#dc2626' : '#065f46' }}>
          {msg}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
        <div>
          <label style={labelStyle}>Primary Colour</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
            <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} style={{ width: '36px', height: '32px', padding: '0', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer' }} />
            <input type="text" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1 }} placeholder="#2563eb" />
          </div>
        </div>
        <div>
          <label style={labelStyle}>Accent Colour</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
            <input type="color" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} style={{ width: '36px', height: '32px', padding: '0', border: '1px solid #e2e8f0', borderRadius: '4px', cursor: 'pointer' }} />
            <input type="text" value={accentColor} onChange={(e) => setAccentColor(e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1 }} placeholder="#16a34a" />
          </div>
        </div>
      </div>
      <label style={labelStyle}>Font Family</label>
      <input type="text" value={fontFamily} onChange={(e) => setFontFamily(e.target.value)} style={inputStyle} placeholder="Inter, system-ui, sans-serif" />
      <label style={labelStyle}>Hero Image URL</label>
      <input type="url" value={heroImageUrl} onChange={(e) => setHeroImageUrl(e.target.value)} style={inputStyle} placeholder="https://cdn.example.com/hero.jpg" />
      <label style={labelStyle}>Announcement Bar</label>
      <input type="text" value={announcementBar} onChange={(e) => setAnnouncementBar(e.target.value)} style={inputStyle} placeholder="Free delivery on orders above ₦10,000!" />

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginTop: '4px' }}>
        <Button onClick={handleSave} primary>{saving ? 'Saving…' : 'Save Theme'}</Button>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <div style={{ width: '16px', height: '16px', borderRadius: '4px', backgroundColor: primaryColor, border: '1px solid #e2e8f0' }} />
          <div style={{ width: '16px', height: '16px', borderRadius: '4px', backgroundColor: accentColor, border: '1px solid #e2e8f0' }} />
          <span style={{ fontSize: '11px', color: '#64748b', fontFamily: fontFamily }}>Aa — {fontFamily.split(',')[0]?.trim()}</span>
        </div>
      </div>
    </div>
  );
};

export const MarketplaceAdminDashboard: React.FC<{ user: User; config: TenantConfig; tenantId?: string; adminKey?: string }> = ({ user, config, tenantId = 'default', adminKey = '' }) => {
  return (
    <div style={{ padding: '20px', maxWidth: '900px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Marketplace Owner Dashboard</h2>
      <p>Welcome, {user.name} ({user.role}) | Tenant: {config.name}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
        <Card title="Total GMV">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>₦1,250,000</div>
        </Card>
        <Card title="Marketplace Revenue">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#2563eb' }}>₦125,000</div>
          <p style={{ margin: '4px 0', color: '#64748b', fontSize: '12px' }}>10% Commission</p>
        </Card>
        <Card title="Active Vendors">
          <div style={{ fontSize: '24px', fontWeight: 'bold' }}>24</div>
        </Card>
      </div>

      <Card title="Vendor Management">
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '8px' }}>Vendor Name</th>
              <th style={{ padding: '8px' }}>Tenant ID</th>
              <th style={{ padding: '8px' }}>Status</th>
              <th style={{ padding: '8px' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '8px' }}>Vendor A (Shea Butter)</td>
              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>tenant_vendor_001</td>
              <td style={{ padding: '8px' }}><span style={{ color: '#16a34a' }}>Active</span></td>
              <td style={{ padding: '8px' }}><Button onClick={() => {}}>Manage</Button></td>
            </tr>
            <tr>
              <td style={{ padding: '8px' }}>Vendor B (Black Soap)</td>
              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>tenant_vendor_002</td>
              <td style={{ padding: '8px' }}><span style={{ color: '#16a34a' }}>Active</span></td>
              <td style={{ padding: '8px' }}><Button onClick={() => {}}>Manage</Button></td>
            </tr>
          </tbody>
        </table>
      </Card>

      <Card title="Commission Management (MV-E02)">
        <CommissionManagement tenantId={tenantId} />
      </Card>

      <Card title="Review Moderation (SV-E07)">
        <ReviewModeration tenantId={tenantId} adminKey={adminKey} />
      </Card>

      <Card title="Dispute Management (MV-E08)">
        <DisputeManagement tenantId={tenantId} adminKey={adminKey} />
      </Card>

      <Card title="Storefront Theme Editor (SV-E09)">
        <ThemeEditor tenantId={tenantId} adminKey={adminKey} />
      </Card>
    </div>
  );
};

export const VendorAdminDashboard: React.FC<{ user: User; config: TenantConfig }> = ({ user, config }) => {
  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Vendor Dashboard</h2>
      <p>Welcome, {user.name} ({user.role}) | Vendor: {config.name}</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <Card title="My Sales">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#16a34a' }}>₦45,000</div>
          <p style={{ margin: '4px 0', color: '#64748b', fontSize: '12px' }}>Net after 10% commission</p>
        </Card>
        <Card title="Pending Payouts">
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#eab308' }}>₦15,000</div>
        </Card>
      </div>

      <Card title="My Inventory">
        <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
              <th style={{ padding: '8px' }}>Product</th>
              <th style={{ padding: '8px' }}>SKU</th>
              <th style={{ padding: '8px' }}>Stock</th>
              <th style={{ padding: '8px' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
              <td style={{ padding: '8px' }}>Raw Shea Butter (500g)</td>
              <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '12px' }}>SHB-500</td>
              <td style={{ padding: '8px' }}>45</td>
              <td style={{ padding: '8px' }}><Button onClick={() => {}}>Update Stock</Button></td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
};
