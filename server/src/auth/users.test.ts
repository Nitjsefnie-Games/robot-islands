import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser, findByEmail, findById, EmailTakenError } from './users.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('users repo', () => {
  it('creates and finds by id', async () => {
    const u = await createUser(pool, 'A@Example.com', 'hash1');
    expect(u.email).toBe('A@Example.com');
    const found = await findById(pool, u.id);
    expect(found?.email).toBe('A@Example.com');
  });

  it('findByEmail is case-insensitive and returns the password', async () => {
    await createUser(pool, 'mixed@Case.com', 'hash2');
    const row = await findByEmail(pool, 'MIXED@case.COM');
    expect(row?.password).toBe('hash2');
  });

  it('rejects duplicate email with EmailTakenError', async () => {
    await createUser(pool, 'dup@x.com', 'h');
    await expect(createUser(pool, 'DUP@x.com', 'h2')).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('returns null for unknown lookups', async () => {
    expect(await findByEmail(pool, 'nobody@x.com')).toBeNull();
    expect(await findById(pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
