/**
 * @webwaka/core — PIN Hashing Utility
 * PBKDF2-SHA256, 100,000 iterations. Web Crypto API only (Cloudflare Workers compatible).
 * Used for POS cashier PIN, customer wallet PIN.
 */

/**
 * Hash a PIN using PBKDF2-SHA256 with 100,000 iterations.
 * Generates a random salt via crypto.randomUUID() if none is provided.
 *
 * @returns { hash: base64-encoded derived key, salt: UUID used }
 */
export async function hashPin(
  pin: string,
  salt?: string,
): Promise<{ hash: string; salt: string }> {
  const usedSalt = salt ?? crypto.randomUUID();
  const enc = new TextEncoder();

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(usedSalt),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256,
  );

  const hashBytes = new Uint8Array(derivedBits);
  let bin = '';
  hashBytes.forEach((b) => { bin += String.fromCharCode(b); });
  const hash = btoa(bin);

  return { hash, salt: usedSalt };
}

/**
 * Verify a PIN against a stored hash and salt.
 *
 * @returns true if the PIN matches the stored hash
 */
export async function verifyPin(
  pin: string,
  storedHash: string,
  salt: string,
): Promise<boolean> {
  const { hash } = await hashPin(pin, salt);
  return hash === storedHash;
}
