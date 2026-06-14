// server/src/game/intents.test.ts
//
// Per-intent coverage for the 8 intents wired in slice-3 Task 2 (the
// `place-building` reference intent is covered in intent-runner.test.ts). Each
// intent gets a pair: a LEGAL call -> ok:true + the expected authoritative
// mutation (asserted via reloaded snapshot), and an ILLEGAL/malformed call ->
// ok:false + the stored save byte-identical (no-partial-persist, design §10).
//
// Pattern for the no-change assertion: pin `now` so loadAndCatchUp's re-persist
// is idempotent (0ms gap -> identical bytes), prime once at `now`, snapshot the
// stored row, fire the rejected intent, assert the row is byte-for-byte equal.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { createInitialSnapshot } from './new-game.js';
import { applyIntent } from './intent-runner.js';
import type { SaveSnapshot } from '../../../src/persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';
import { makeInitialIslandState } from '../../../src/world.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function newUser(): Promise<string> {
  return (await createUser(pool, `${Math.random()}@x.com`, 'h')).id;
}

/** Persist `snap` for a fresh user and return the user id. */
async function userWithSnapshot(snap: SaveSnapshot): Promise<string> {
  const uid = await newUser();
  await saveSnapshot(pool, uid, snap);
  return uid;
}

/** A user with a brand-new starter game. */
async function aUserWithGame(): Promise<string> {
  return userWithSnapshot(createInitialSnapshot(Date.now()));
}

/** Read the home island's runtime state out of the stored snapshot. */
async function homeState(uid: string): Promise<Record<string, unknown>> {
  const snap = await loadSnapshot(pool, uid);
  const home = snap!.islandStates.find((e) => e.id === 'home')!;
  return home.state as unknown as Record<string, unknown>;
}

async function homeBuildings(uid: string): Promise<Array<Record<string, unknown>>> {
  return (await homeState(uid)).buildings as Array<Record<string, unknown>>;
}

/** Place a building via the place-building intent and return its minted id
 *  (deterministic `placed-0` for the first placement on an empty island). */
async function placeBuilding(
  uid: string,
  defId: string,
  x: number,
  y: number,
  now: number,
): Promise<string> {
  const ack = await applyIntent(
    pool, uid,
    { type: 'place-building', payload: { islandId: 'home', defId, x, y, rotation: 0 }, seq: 1 },
    now,
  );
  expect(ack.ok).toBe(true);
  const buildings = await homeBuildings(uid);
  const placed = buildings.find((b) => b.defId === defId)!;
  return placed.id as string;
}

/** Assert: firing `envelope` at the pinned `now` is rejected AND leaves the
 *  stored save byte-identical. Primes once so catch-up has already run. */
async function expectRejectNoChange(
  uid: string,
  envelope: { type: string; payload: unknown; seq: number },
  now: number,
): Promise<void> {
  await applyIntent(pool, uid, envelope, now); // prime catch-up at `now`
  const before = await loadSnapshot(pool, uid);
  const ack = await applyIntent(pool, uid, envelope, now);
  expect(ack.ok).toBe(false);
  const after = await loadSnapshot(pool, uid);
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
}

describe('demolish-building', () => {
  it('legal: removes the building and credits a refund', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'demolish-building', payload: { islandId: 'home', buildingId: id }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    // The authoritative mutation: the building is gone.
    const buildings = await homeBuildings(uid);
    expect(buildings.some((b) => b.id === id)).toBe(false);
    // The refunding path ran: scrap is credited (clamped to its cap of 100 —
    // the starter scrap stockpile is over-cap, so the credit write lands the
    // cap exactly, proving demolishBuilding's scrap-credit branch executed).
    const scrapAfter = ((await homeState(uid)).inventory as Record<string, number>).scrap ?? 0;
    expect(scrapAfter).toBe(100);
  });

  it('illegal: unknown buildingId is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'demolish-building', payload: { islandId: 'home', buildingId: 'nope' }, seq: 9 },
      now,
    );
  });
});

describe('cancel-construction', () => {
  it('legal: cancels a fresh placement, removes building, refunds materials', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'cancel-construction', payload: { islandId: 'home', buildingId: id }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    // The authoritative mutation: a fresh-placement cancel removes the building
    // (and refunds 100% of materials — invisible here only because the starter
    // stockpiles are already over their 100-unit caps, so the credit clamps).
    const buildings = await homeBuildings(uid);
    expect(buildings.some((b) => b.id === id)).toBe(false);
    // Re-cancelling now fails: the job is gone (dequeued), proving it landed.
    const dup = await applyIntent(
      pool, uid,
      { type: 'cancel-construction', payload: { islandId: 'home', buildingId: id }, seq: 3 },
      now,
    );
    expect(dup).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('illegal: unknown buildingId is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'cancel-construction', payload: { islandId: 'home', buildingId: 'nope' }, seq: 9 },
      now,
    );
  });
});

describe('upgrade-building', () => {
  it('legal: enqueues an upgrade and deducts cost', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);
    const invBefore = (await homeState(uid)).inventory as Record<string, number>;

    const ack = await applyIntent(
      pool, uid,
      { type: 'upgrade-building', payload: { islandId: 'home', buildingId: id }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    // The freshly-placed building is still under construction, so the upgrade
    // QUEUES as a BuildJob (§9.3 stacking) rather than starting immediately.
    const jobs = (state.buildJobs as Array<Record<string, unknown>>) ?? [];
    expect(jobs.some((j) => j.buildingId === id && j.kind === 'upgrade')).toBe(true);
    // Cost was deducted from authoritative inventory.
    const invAfter = state.inventory as Record<string, number>;
    expect(invAfter.wood).toBeLessThan(invBefore.wood);
  });

  it('illegal: unknown buildingId is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'upgrade-building', payload: { islandId: 'home', buildingId: 'nope' }, seq: 9 },
      now,
    );
  });
});

describe('set-active-floors', () => {
  it('legal: sets disabledFloors on the building', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-active-floors', payload: { islandId: 'home', buildingId: id, disabledFloors: 1 }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const buildings = await homeBuildings(uid);
    const b = buildings.find((bb) => bb.id === id)!;
    expect(b.disabledFloors).toBe(1);
  });

  it('illegal: disabledFloors out of range is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);
    // A fresh workshop has 1 floor; asking to disable 5 is out of range. The
    // pure fn would silently clamp, so the handler must reject it.
    await expectRejectNoChange(
      uid,
      { type: 'set-active-floors', payload: { islandId: 'home', buildingId: id, disabledFloors: 5 }, seq: 9 },
      now,
    );
  });
});

describe('dispatch-drone', () => {
  it('legal: launches a drone and lands it in world.drones', async () => {
    const now = Date.now();
    // Starter inventory has no biofuel; mutate the snapshot to grant some so a
    // T1 (biofuel) drone is affordable.
    const snap = createInitialSnapshot(now) as unknown as {
      islandStates: Array<{ id: string; state: { inventory: Record<string, number> } }>;
    };
    const home = snap.islandStates.find((e) => e.id === 'home')!;
    home.state.inventory.biofuel = 100;
    const uid = await userWithSnapshot(snap as unknown as SaveSnapshot);

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'dispatch-drone',
        payload: { islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10 },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const after = await loadSnapshot(pool, uid);
    expect(after!.world.drones.length).toBe(1);
    // Fuel was spent at launch.
    const fuelAfter = ((await homeState(uid)).inventory as Record<string, number>).biofuel;
    expect(fuelAfter).toBe(90);
  });

  it('illegal: insufficient fuel is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame(); // starter has 0 biofuel
    await expectRejectNoChange(
      uid,
      {
        type: 'dispatch-drone',
        payload: { islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10 },
        seq: 9,
      },
      now,
    );
  });
});

describe('create-route', () => {
  // A fresh game populates only `home`. Routes per §2.4 connect SETTLED
  // islands and the routes-UI only ever offers populated endpoints, so the
  // create-route handler requires BOTH endpoints populated. Build a snapshot
  // that marks a second island (`gen-1--3`) populated AND gives it a runtime
  // state, so a home→colony cargo route is a LEGAL distinct destination.
  const COLONY_ID = 'gen-1--3';
  async function aUserWithTwoPopulatedIslands(now: number): Promise<string> {
    const { world, islandStates } = createNewGame(now);
    const colony = world.islands.find((s) => s.id === COLONY_ID)!;
    colony.populated = true;
    colony.discovered = true;
    islandStates.set(COLONY_ID, makeInitialIslandState(colony, now));
    world.islandStates = islandStates;
    return userWithSnapshot(serializeWorld(world, islandStates, now, now));
  }

  it('legal: creates a route between two populated islands', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const after = await loadSnapshot(pool, uid);
    const routes = after!.world.routes;
    expect(routes.length).toBe(1);
    expect(routes[0]).toMatchObject({ from: 'home', to: COLONY_ID, sourceBuildingId: dockId });
  });

  it('illegal: unpopulated destination is rejected, save unchanged', async () => {
    const now = Date.now();
    // Fresh game: `gen-1--3` is present but UNPOPULATED. Routing to it must be
    // rejected (anti-cheat: the routes-UI never offers unpopulated endpoints).
    const uid = await aUserWithGame();
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    await expectRejectNoChange(
      uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId },
        seq: 9,
      },
      now,
    );
  });

  it('illegal: from===to is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    await expectRejectNoChange(
      uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: 'home', buildingId: dockId },
        seq: 9,
      },
      now,
    );
  });
});

describe('unlock-skill-node', () => {
  // Build a level-5 home (tier 2) with surplus SP so a depth-1 node is
  // purchasable. Depth-1 nodes require tier 2 (level >= 5); `mining.recipeRate.1`
  // costs 1 SP.
  async function aUserAtLevel5(sp: number): Promise<string> {
    const now = Date.now();
    const snap = createInitialSnapshot(now) as unknown as {
      islandStates: Array<{ id: string; state: { level: number; unspentSkillPoints: number } }>;
    };
    const home = snap.islandStates.find((e) => e.id === 'home')!;
    home.state.level = 5;
    home.state.unspentSkillPoints = sp;
    return userWithSnapshot(snap as unknown as SaveSnapshot);
  }

  it('legal: unlocks the node and deducts skill points', async () => {
    const now = Date.now();
    const uid = await aUserAtLevel5(100);
    const ack = await applyIntent(
      pool, uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.recipeRate.1' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect(state.unlockedNodes).toContain('mining.recipeRate.1');
    expect(state.unspentSkillPoints).toBe(99); // 100 - cost(1)
  });

  it('illegal: insufficient SP is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserAtLevel5(0); // tier-eligible but no SP
    await expectRejectNoChange(
      uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.recipeRate.1' }, seq: 9 },
      now,
    );
  });

  it('illegal: a keystone target is rejected, save unchanged', async () => {
    const now = Date.now();
    // Even with ample SP, a keystone node must NOT be purchasable via this
    // intent: buyNode throws for keystones (they are bought via buyKeystone),
    // and the no-throw handler contract forbids relying on the runner backstop.
    // The handler rejects keystones explicitly before any buyNode path.
    const uid = await aUserAtLevel5(100);
    const ack = await applyIntent(
      pool, uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 2 },
      now,
    );
    expect(ack.ok).toBe(false);
    await expectRejectNoChange(
      uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 9 },
      now,
    );
  });
});
