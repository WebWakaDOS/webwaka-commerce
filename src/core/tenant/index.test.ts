import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { tenantResolver, requireModule, moduleRegistry } from './index';

describe('Tenant-as-Code & Module Registry', () => {
  it('should register and retrieve modules', () => {
    const posModule = moduleRegistry.get('retail_pos');
    expect(posModule).toBeDefined();
    expect(posModule?.name).toBe('Point of Sale');
  });

  it('should resolve tenant by X-Tenant-ID header', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/test', (c) => {
      const tenant = c.get('tenant');
      return c.json({ tenantId: tenant.tenantId });
    });

    const req = new Request('http://localhost/test', {
      headers: { 'X-Tenant-ID': 'tnt_123' }
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.tenantId).toBe('tnt_123');
  });

  it('should resolve tenant by domain', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/test', (c) => {
      const tenant = c.get('tenant');
      return c.json({ tenantId: tenant.tenantId });
    });

    const req = new Request('http://shop.example.com/test');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.tenantId).toBe('tnt_123');
  });

  it('should return 404 for unknown tenant', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/test', (c) => c.json({ ok: true }));

    const req = new Request('http://unknown.example.com/test');

    const res = await app.fetch(req);
    expect(res.status).toBe(404);
  });

  it('should allow access if module is enabled', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/pos', requireModule('retail_pos'), (c) => c.json({ ok: true }));

    const req = new Request('http://shop.example.com/pos');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
  });

  it('should deny access if module is not enabled', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/marketplace', requireModule('multi_vendor_marketplace'), (c) => c.json({ ok: true }));

    // shop.example.com does not have multi_vendor_marketplace enabled
    const req = new Request('http://shop.example.com/marketplace');

    const res = await app.fetch(req);
    expect(res.status).toBe(403);
  });

  it('should support scoped vendor tenants (marketplaceId + tenantId)', async () => {
    const app = new Hono<{ Variables: { tenant: any } }>();
    app.use('*', tenantResolver);
    app.get('/test', (c) => {
      const tenant = c.get('tenant');
      return c.json({ 
        tenantId: tenant.tenantId,
        marketplaceId: tenant.marketplaceId
      });
    });

    const req = new Request('http://vendor1.marketplace.com/test');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    
    const data = await res.json();
    expect(data.tenantId).toBe('tnt_vendor_1');
    expect(data.marketplaceId).toBe('tnt_marketplace_1');
  });
});
