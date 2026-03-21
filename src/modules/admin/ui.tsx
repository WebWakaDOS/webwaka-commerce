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

export const MarketplaceAdminDashboard: React.FC<{ user: User; config: TenantConfig }> = ({ user, config }) => {
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
