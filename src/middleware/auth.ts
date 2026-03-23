/**
 * WebWaka Commerce Suite — JWT Authentication Middleware
 * Reuses the Super Admin V2 auth pattern for consistency (Build Once Use Infinitely).
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole } from '@webwaka/core';

export const jwtAuthMiddleware = coreJwtAuthMiddleware({
  publicRoutes: [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/api/pos/products' },
    { method: 'GET', path: '/api/single-vendor/products' },
    { method: 'GET', path: '/api/multi-vendor/products' },
    { method: 'GET', path: '/api/multi-vendor/vendors' },
  ]
});

export const requireRole = coreRequireRole;
