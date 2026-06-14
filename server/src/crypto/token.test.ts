import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from './token.js';

describe('token', () => {
  it('generates url-safe tokens of stable length', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it('generates unique tokens', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
  });

  it('hashToken is deterministic and 32 bytes', () => {
    const t = generateToken();
    const h1 = hashToken(t);
    const h2 = hashToken(t);
    expect(h1.equals(h2)).toBe(true);
    expect(h1.length).toBe(32);
  });

  it('hash differs from the raw token', () => {
    const t = generateToken();
    expect(hashToken(t).toString('base64url')).not.toBe(t);
  });
});
