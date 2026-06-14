import { createHash, randomBytes } from 'node:crypto';

/** Raw opaque session token — goes in the cookie, never stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 of the raw token — this is what the sessions table stores. */
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}
