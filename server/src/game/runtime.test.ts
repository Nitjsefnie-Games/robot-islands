// server/src/game/runtime.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { loadAndCatchUp } from './runtime.js';
import { createInitialSnapshot } from './new-game.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'r@x.com', 'h')).id; }

describe('runtime loadAndCatchUp', () => {
  it('returns deserialized state and persists an advanced snapshot', async () => {
    const uid = await aUser();
    // Save a snapshot stamped ~2 hours ago so there is an offline gap.
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const snap = createInitialSnapshot(twoHoursAgo);
    await saveSnapshot(pool, uid, snap);

    const result = await loadAndCatchUp(pool, uid, Date.now());
    expect(result).not.toBeNull();
    expect(result!.islandStates.get('home')).toBeDefined();

    // Persisted snapshot's savedAt advanced to ~now (catch-up was saved).
    const after = await loadSnapshot(pool, uid);
    expect(after!.savedAt).toBeGreaterThan(snap.savedAt);
  });

  it('returns null when the account has no save', async () => {
    const uid = await aUser();
    expect(await loadAndCatchUp(pool, uid, Date.now())).toBeNull();
  });
});
