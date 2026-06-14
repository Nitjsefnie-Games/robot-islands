import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from './users.js';
import { createSession, findValidSession, revokeSession, reapSessions } from './sessions.js';
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

  it('reapSessions deletes expired sessions and leaves valid ones', async () => {
    const uid = await aUser();
    const validTh = hashToken('tok-valid');
    const expiredTh = hashToken('tok-expired');
    await createSession(pool, uid, validTh, new Date(Date.now() + 60_000));
    await createSession(pool, uid, expiredTh, new Date(Date.now() - 1000));
    expect(await reapSessions(pool)).toBeGreaterThanOrEqual(1);
    expect(await findValidSession(pool, validTh, new Date())).not.toBeNull();
    expect(await findValidSession(pool, expiredTh, new Date())).toBeNull();
  });

  it('reapSessions deletes revoked sessions older than 7 days but keeps recent revocations', async () => {
    const uid = await aUser();
    const recentTh = hashToken('tok-revoked-recent');
    const oldTh = hashToken('tok-revoked-old');
    await createSession(pool, uid, recentTh, new Date(Date.now() + 60_000));
    await createSession(pool, uid, oldTh, new Date(Date.now() + 60_000));
    await revokeSession(pool, recentTh, new Date());
    // Simulate a revocation 8 days ago for the old session.
    await pool.query('UPDATE sessions SET revoked_at = now() - interval \'8 days\' WHERE token_hash = $1', [oldTh]);
    expect(await reapSessions(pool)).toBeGreaterThanOrEqual(1);
    expect(await findValidSession(pool, recentTh, new Date())).toBeNull(); // still revoked
    expect(await findValidSession(pool, oldTh, new Date())).toBeNull(); // deleted
  });
});
