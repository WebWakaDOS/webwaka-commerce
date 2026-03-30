import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { tenantResolver, requireModule, moduleRegistry, createTenantResolverMiddleware, TenantConfig } from './index';

// ── Mock KV namespace for createTenantResolverMiddleware tests ────────────────
function makeMockKV(store: Record<string, unknown>): KVNamespace {
  return {
    get: async (key: string, type?: string) => {
      const val = store[key];
      if (val === undefined) return null;
      if (type === 'json') return val as any;
      return JSON.stringify(val);
    },
  } as unknown as KVNamespace;
}

const demoConfig: TenantConfig = {
  tenantId: 'tnt_demo',
  domain: 'demo.webwaka.shop',
  enabledModules: ['retail_pos', 'single_vendor_storefront'],
  branding: { primaryColor: '#1A56DB', logoUrl: '/logo.png' },
  permissions: { admin: ['*'] },
  featureFlags: { ai_recommendations: false },
};

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
      headers: { 'X-Tenant-ID': 'tnt_123' },
    });

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json() as { tenantId: string };
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

    const data = await res.json() as { tenantId: string };
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
        marketplaceId: tenant.marketplaceId,
      });
    });

    const req = new Request('http://vendor1.marketplace.com/test');

    const res = await app.fetch(req);
    expect(res.status).toBe(200);

    const data = await res.json() as { tenantId: string; marketplaceId: string };
    expect(data.tenantId).toBe('tnt_vendor_1');
    expect(data.marketplaceId).toBe('tnt_marketplace_1');
  });
});

// ── createTenantResolverMiddleware — KV-backed (P0-T07) ───────────────────────
describe('createTenantResolverMiddleware (KV-backed)', () => {
  function buildApp(kv: KVNamespace) {
    const app = new Hono<{ Variables: { tenantConfig: TenantConfig } }>();
    app.use('*', createTenantResolverMiddleware(kv));
    app.get('/test', (c) => {
      const config = c.get('tenantConfig' as never) as TenantConfig;
      return c.json({ tenantId: config?.tenantId, modules: config?.enabledModules });
    });
    return app;
  }

  it('resolves tenant and sets tenantConfig in context', async () => {
    const kv = makeMockKV({ 'tenant:tnt_demo': demoConfig });
    const app = buildApp(kv);
    const req = new Request('http://localhost/test', {
      headers: { 'x-tenant-id': 'tnt_demo' },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { tenantId: string; modules: string[] };
    expect(data.tenantId).toBe('tnt_demo');
    expect(data.modules).toContain('retail_pos');
  });

  it('returns 404 when tenant is not found in KV', async () => {
    const kv = makeMockKV({});
    const app = buildApp(kv);
    const req = new Request('http://localhost/test', {
      headers: { 'x-tenant-id': 'tnt_unknown' },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(404);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe('Tenant not found');
  });

  it('returns 400 when x-tenant-id header is missing', async () => {
    const kv = makeMockKV({ 'tenant:tnt_demo': demoConfig });
    const app = buildApp(kv);
    const req = new Request('http://localhost/test');
    const res = await app.fetch(req);
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe('Missing tenant identifier');
  });

  it('reads the KV key as tenant:<tenantId>', async () => {
    const kv = makeMockKV({ 'tenant:tnt_acme': { ...demoConfig, tenantId: 'tnt_acme' } });
    const app = buildApp(kv);
    const req = new Request('http://localhost/test', {
      headers: { 'X-Tenant-ID': 'tnt_acme' },
    });
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const data = await res.json() as { tenantId: string };
    expect(data.tenantId).toBe('tnt_acme');
  });
});
