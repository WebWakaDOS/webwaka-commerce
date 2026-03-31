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

export const MarketplaceAdminDashboard: React.FC<{ user: User; config: TenantConfig; tenantId?: string }> = ({ user, config, tenantId = 'default' }) => {
  return (
    <div style={{ padding: '20px', maxWidth: '800px', margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
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
