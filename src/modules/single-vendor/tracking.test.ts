/**
 * T-CVC-02: Single-Vendor Order Tracking Redirect Tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { singleVendorRouter } from './api';

describe('GET /cmrc_orders/:id/track — order tracking redirect (T-CVC-02)', () => {
  const mockOrder = { 
    id: 'ord_sv_001', 
    order_status: 'confirmed', 
    payment_status: 'paid', 
    created_at: 1700000000, 
    updated_at: 1700000000 
  };

  const mockDb = {
    prepare: vi.fn().mockReturnThis(),
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(),
  };

  const mockEnv = { 
    DB: mockDb, 
    TENANT_CONFIG: {}, 
    EVENTS: {}, 
    JWT_SECRET: 'test-secret-32-chars-minimum!!!',
    INTER_SERVICE_SECRET: 'test-inter-service-secret'
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockDb.prepare.mockReturnThis();
    mockDb.bind.mockReturnThis();
  });

  it('redirects to Logistics portal when binding is present', async () => {
    mockDb.first.mockResolvedValue({ id: 'ord_sv_001' });
    const mockLogisticsWorker = {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({
        success: true,
        data: { trackingUrl: 'https://logistics.webwaka.ng/track?token=signed-token-sv' }
      }), { status: 200 })),
    };
    const envWithBinding = { ...mockEnv, LOGISTICS_WORKER: mockLogisticsWorker };
    const req = new Request('http://test/cmrc_orders/ord_sv_001/track', { 
      headers: { 'x-tenant-id': 'tenant1' } 
    });
    const res = await singleVendorRouter.fetch(req, envWithBinding as any);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://logistics.webwaka.ng/track?token=signed-token-sv');
    expect(mockLogisticsWorker.fetch).toHaveBeenCalled();
  });

  it('falls back to Commerce status when Logistics is unavailable', async () => {
    mockDb.first.mockResolvedValue(mockOrder);
    const req = new Request('http://test/cmrc_orders/ord_sv_001/track', { 
      headers: { 'x-tenant-id': 'tenant1' } 
    });
    const res = await singleVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(body.note).toBe('logistics_unavailable');
    expect(body.data.id).toBe('ord_sv_001');
  });

  it('returns 404 for non-existent order', async () => {
    mockDb.first.mockResolvedValue(null);
    const req = new Request('http://test/cmrc_orders/ord_notfound/track', { 
      headers: { 'x-tenant-id': 'tenant1' } 
    });
    const res = await singleVendorRouter.fetch(req, mockEnv as any);
    expect(res.status).toBe(404);
  });
});
