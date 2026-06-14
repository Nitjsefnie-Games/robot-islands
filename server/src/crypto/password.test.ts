import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hash is PHC-formatted and not the plaintext', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).not.toContain('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h.split('$')).toHaveLength(4); // scrypt$params$salt$hash
  });

  it('verify roundtrips', async () => {
    const h = await hashPassword('hunter2hunter2');
    expect(await verifyPassword(h, 'hunter2hunter2')).toBe(true);
  });

  it('verify rejects wrong password', async () => {
    const h = await hashPassword('hunter2hunter2');
    expect(await verifyPassword(h, 'wrongpassword')).toBe(false);
  });

  it('two hashes of the same password differ (random salt)', async () => {
    expect(await hashPassword('samepasswordhere')).not.toBe(await hashPassword('samepasswordhere'));
  });

  it('verify returns false on malformed stored hash', async () => {
    expect(await verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});
