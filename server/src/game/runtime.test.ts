// server/src/game/runtime.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { loadAndCatchUp } from './runtime.js';
import { createInitialSnapshot } from './new-game.js';
import { SCHEMA_VERSION, type SaveSnapshot } from '../../../src/persistence.js';

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

  it('migrates an older-version snapshot on load and re-persists at the current version', async () => {
    const uid = await aUser();
    // Build a complete current snapshot, then DOWNGRADE it to v23 by removing the
    // single field v23->v24 added at the island-state level (buildJobs). A fresh
    // game has no disabled buildings, so the building-level part of that migration
    // is moot here. This yields a valid v23 input that deserializeWorld migrates.
    const current = createInitialSnapshot(0);
    const v23 = JSON.parse(JSON.stringify(current)) as SaveSnapshot & {
      islandStates: Array<{ id: string; state: Record<string, unknown> }>;
    };
    v23.v = 23 as SaveSnapshot['v'];
    for (const entry of v23.islandStates) delete entry.state.buildJobs;
    await saveSnapshot(pool, uid, v23 as unknown as SaveSnapshot);

    const game = await loadAndCatchUp(pool, uid, Date.now());
    expect(game).not.toBeNull();
    expect(game!.islandStates.get('home')).toBeDefined();

    // Re-persisted snapshot is now at the current schema version.
    const reloaded = await loadSnapshot(pool, uid);
    expect(reloaded!.v).toBe(SCHEMA_VERSION);
  });
});
