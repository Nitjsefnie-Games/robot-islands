import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hash is PHC-formatted and not the plaintext', () => {
    const h = hashPassword('correct horse battery staple');
    expect(h).not.toContain('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h.split('$')).toHaveLength(4); // scrypt$params$salt$hash
  });

  it('verify roundtrips', () => {
    const h = hashPassword('hunter2hunter2');
    expect(verifyPassword(h, 'hunter2hunter2')).toBe(true);
  });

  it('verify rejects wrong password', () => {
    const h = hashPassword('hunter2hunter2');
    expect(verifyPassword(h, 'wrongpassword')).toBe(false);
  });

  it('two hashes of the same password differ (random salt)', () => {
    expect(hashPassword('samepasswordhere')).not.toBe(hashPassword('samepasswordhere'));
  });

  it('verify returns false on malformed stored hash', () => {
    expect(verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});
