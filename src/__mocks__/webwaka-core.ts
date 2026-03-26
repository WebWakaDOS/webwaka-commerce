import type { Context, MiddlewareHandler } from 'hono';

export const getTenantId = (c: Context): string | null => {
  return c.req.raw.headers.get('x-tenant-id');
};

export const requireRole = (_roles: string[]): MiddlewareHandler => {
  return async (_c, next) => {
    await next();
  };
};

export const jwtAuthMiddleware = (): MiddlewareHandler => {
  return async (_c, next) => {
    await next();
  };
};
