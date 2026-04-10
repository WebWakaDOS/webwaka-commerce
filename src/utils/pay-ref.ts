/**
 * Payment reference generator (P0-T06)
 *
 * Produces a short, uppercase, collision-resistant reference suitable for
 * Paystack or other payment gateways.  Format: `PAY_<12 hex chars>`.
 * Relies on `crypto.randomUUID()` which is available in both Cloudflare
 * Workers and Node.js 14.17+.
 */

/**
 * Generate a unique payment reference.
 * @returns e.g. "PAY_A3F1B8C94D2E"
 */
export function generatePayRef(): string {
  return `PAY_${crypto.randomUUID().replace(/-/g, '').toUpperCase().slice(0, 12)}`;
}
