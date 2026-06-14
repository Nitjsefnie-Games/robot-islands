import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from './users.js';
import { createSession, findValidSession, revokeSession } from './sessions.js';
import { hashToken } from '../crypto/token.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'sess@x.com', 'h')).id; }

describe('sessions repo', () => {
  it('creates then finds a valid session (joined to user)', async () => {
    const uid = await aUser();
    const th = hashToken('tok-a');
    await createSession(pool, uid, th, new Date(Date.now() + 60_000));
    const s = await findValidSession(pool, th, new Date());
    expect(s?.userId).toBe(uid);
    expect(s?.email).toBe('sess@x.com');
  });

  it('does not find an expired session', async () => {
    const uid = await aUser();
    const th = hashToken('tok-b');
    await createSession(pool, uid, th, new Date(Date.now() - 1000));
    expect(await findValidSession(pool, th, new Date())).toBeNull();
  });

  it('revoke makes a session invalid', async () => {
    const uid = await aUser();
    const th = hashToken('tok-c');
    await createSession(pool, uid, th, new Date(Date.now() + 60_000));
    await revokeSession(pool, th, new Date());
    expect(await findValidSession(pool, th, new Date())).toBeNull();
  });

  it('only stores the hash, never a recoverable raw token', async () => {
    const uid = await aUser();
    await createSession(pool, uid, hashToken('secret-raw'), new Date(Date.now() + 60_000));
    const res = await pool.query("SELECT encode(token_hash,'escape') AS h FROM sessions");
    expect(res.rows[0].h).not.toContain('secret-raw');
  });
});
