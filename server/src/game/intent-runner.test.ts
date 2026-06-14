// server/src/game/intent-runner.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { createInitialSnapshot } from './new-game.js';
import { applyIntent } from './intent-runner.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUserWithGame(): Promise<string> {
  const uid = (await createUser(pool, `${Math.random()}@x.com`, 'h')).id;
  await saveSnapshot(pool, uid, createInitialSnapshot(Date.now()));
  return uid;
}

// A workshop (tier 1, single tile, no terrain requirement) is unlocked at the
// home island's starting level 1 and affordable from the §14 starter kit
// (wood 600 / stone 100 / iron_ingot 60 vs cost wood150/stone100/iron_ingot30).
// (0,0) is the home island centre — well inside its 16-tile ellipse.
const LEGAL_PLACE = {
  type: 'place-building',
  payload: { islandId: 'home', defId: 'workshop', x: 0, y: 0, rotation: 0 },
  seq: 7,
};

describe('applyIntent', () => {
  it('rejects an unknown intent type without persisting', async () => {
    const uid = await aUserWithGame();
    const before = await loadSnapshot(pool, uid);
    const ack = await applyIntent(pool, uid, { type: 'no-such-intent', payload: {}, seq: 1 }, Date.now());
    expect(ack).toMatchObject({ seq: 1, ok: false, error: 'unknown intent' });
    // loadAndCatchUp re-persists an advanced snapshot; the unknown-intent
    // rejection itself must not add a building.
    const after = await loadSnapshot(pool, uid);
    const home = after!.islandStates.find((e) => e.id === 'home')!;
    expect((home.state as { buildings: unknown[] }).buildings).toHaveLength(0);
    expect(before!.v).toBe(after!.v);
  });

  it('rejects when the account has no game', async () => {
    const uid = (await createUser(pool, 'nogame@x.com', 'h')).id;
    const ack = await applyIntent(pool, uid, LEGAL_PLACE, Date.now());
    expect(ack).toMatchObject({ seq: 7, ok: false, error: 'no game' });
  });

  it('applies a legal place-building: ok, projection shows the building, save advances', async () => {
    const uid = await aUserWithGame();
    const ack = await applyIntent(pool, uid, LEGAL_PLACE, Date.now());
    expect(ack.ok).toBe(true);
    expect(ack.seq).toBe(7);

    // Stored save now carries the new building.
    const after = await loadSnapshot(pool, uid);
    const home = after!.islandStates.find((e) => e.id === 'home')!;
    const buildings = (home.state as { buildings: Array<{ defId: string }> }).buildings;
    expect(buildings.some((b) => b.defId === 'workshop')).toBe(true);

    // Projection round-trip (reload) reflects the new building -> reapplying the
    // SAME placement at (0,0) now fails with overlap, proving it landed.
    const dup = await applyIntent(pool, uid, LEGAL_PLACE, Date.now());
    expect(dup).toMatchObject({ ok: false, error: 'overlap' });
  });

  it('rejects an unaffordable place-building and persists nothing (byte-identical save)', async () => {
    const uid = await aUserWithGame();
    // Use a FIXED `now` for both the priming call and the rejected intent.
    // loadAndCatchUp re-persists an advanced snapshot on EVERY call; pinning
    // `now` makes catch-up idempotent (0ms elapsed -> identical bytes), so the
    // only thing that could change the stored row is a (forbidden) partial
    // persist from the rejected intent.
    const now = Date.now();
    // Prime: one rejected call at `now` writes the catch-up snapshot once.
    const unaffordable = {
      type: 'place-building',
      // deep_mine needs concrete 12000 / gear 500 / clay 2000 etc — the starter
      // kit has none of those, so the §14 cost gate rejects. (It also requires
      // an 'ore' tile, which the home plains centre isn't, so validatePlacement
      // rejects with tile-requirement-not-met before cost.) Either way it's
      // rejected and nothing beyond catch-up is persisted.
      payload: { islandId: 'home', defId: 'deep_mine', x: 0, y: 0, rotation: 0 },
      seq: 99,
    };
    await applyIntent(pool, uid, unaffordable, now);
    const before = await loadSnapshot(pool, uid);

    const ack = await applyIntent(pool, uid, unaffordable, now);
    expect(ack.ok).toBe(false);
    expect((ack as { seq: number }).seq).toBe(99);

    const after = await loadSnapshot(pool, uid);
    // No-partial-persist: the stored snapshot is byte-identical to before the
    // rejected intent. (applyIntent never calls saveSnapshot on a rejection;
    // catch-up at the pinned `now` rewrites identical bytes.)
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});
