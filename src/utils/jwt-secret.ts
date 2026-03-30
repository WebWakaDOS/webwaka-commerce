/**
 * JWT Secret — Production-safe accessor (Production Hardening)
 *
 * Throws an explicit Error if JWT_SECRET is not configured in the environment.
 * This causes a clean 500 response rather than silently signing/verifying tokens
 * with the insecure well-known fallback `dev-secret-change-me`.
 *
 * Usage:
 *   import { getJwtSecret } from '../../utils/jwt-secret';
 *   const secret = getJwtSecret(c.env);
 *
 * Local dev: set JWT_SECRET in .dev.vars (wrangler dev picks it up automatically).
 * Production: `wrangler secret put JWT_SECRET --env production`
 */
export function getJwtSecret(env: { JWT_SECRET?: string }): string {
  if (!env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET environment variable is required but not configured. ' +
        'Set it via: wrangler secret put JWT_SECRET',
    );
  }
  return env.JWT_SECRET;
}
