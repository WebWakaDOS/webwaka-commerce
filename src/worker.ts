/**
 * WebWaka Commerce Suite - Unified Cloudflare Worker Entry Point
 * Mounts all Commerce modules: POS, Single-Vendor, Multi-Vendor
 * Invariant compliance: Multi-tenancy, Nigeria-First, Offline-First
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { posRouter } from './modules/pos/api';
import { singleVendorRouter } from './modules/single-vendor/api';
import { multiVendorRouter } from './modules/multi-vendor/api';

export interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  EVENTS: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
}));

// Health check
app.get('/health', (c) => {
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env?.DB ? 'production' : 'development',
      version: '4.0.0',
      modules: ['pos', 'single-vendor', 'multi-vendor'],
      timestamp: new Date().toISOString(),
    }
  });
});

// Mount Commerce modules
app.route('/api/pos', posRouter);
app.route('/api/single-vendor', singleVendorRouter);
app.route('/api/multi-vendor', multiVendorRouter);

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Route not found',
    availableRoutes: ['/health', '/api/pos', '/api/single-vendor', '/api/multi-vendor'],
  }, 404);
});

export default app;
