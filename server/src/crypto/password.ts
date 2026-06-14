import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 32768; // 2**15
const r = 8;
const p = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024; // 128*N*r ~= 33.5MB; give headroom

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$N=${N},r=${r},p=${p}$${b64url(salt)}$${b64url(hash)}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params = parts[1]!;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!m) return false;
  const pn = Number(m[1]), pr = Number(m[2]), pp = Number(m[3]);
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, 'base64url');
    expected = Buffer.from(parts[3]!, 'base64url');
  } catch {
    return false;
  }
  let candidate: Buffer;
  try {
    candidate = scryptSync(password, salt, expected.length, { N: pn, r: pr, p: pp, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
