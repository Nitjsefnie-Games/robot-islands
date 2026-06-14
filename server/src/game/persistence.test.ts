// server/src/game/persistence.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot, hasSave } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'g@x.com', 'h')).id; }

describe('game persistence', () => {
  it('hasSave is false before, true after', async () => {
    const uid = await aUser();
    expect(await hasSave(pool, uid)).toBe(false);
    const { world, islandStates } = createNewGame(1000);
    await saveSnapshot(pool, uid, serializeWorld(world, islandStates, 1000, 1000));
    expect(await hasSave(pool, uid)).toBe(true);
  });

  it('roundtrips a snapshot identically', async () => {
    const uid = await aUser();
    const { world, islandStates } = createNewGame(1000);
    const snap = serializeWorld(world, islandStates, 1000, 1000);
    await saveSnapshot(pool, uid, snap);
    const loaded = await loadSnapshot(pool, uid);
    expect(loaded).toEqual(snap);
  });

  it('saveSnapshot upserts (second save overwrites)', async () => {
    const uid = await aUser();
    const { world: wA, islandStates: sA } = createNewGame(1000);
    const a = serializeWorld(wA, sA, 1000, 1000);
    const { world: wB, islandStates: sB } = createNewGame(2000);
    const b = serializeWorld(wB, sB, 2000, 2000);
    await saveSnapshot(pool, uid, a);
    await saveSnapshot(pool, uid, b);
    const loaded = await loadSnapshot(pool, uid);
    expect(loaded?.savedAt).toBe(2000);
  });

  it('loadSnapshot returns null when none', async () => {
    const uid = await aUser();
    expect(await loadSnapshot(pool, uid)).toBeNull();
  });
});
