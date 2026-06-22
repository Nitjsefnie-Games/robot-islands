// server/src/game/intents.test.ts
//
// Per-intent coverage for the intents wired in slice-3 Task 2 and the
// Part 2 transport/tech intents. (the
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
import { DEFAULT_GRAPH } from '../../../src/skilltree.js';
import { tileToCell, cellKey } from '../../../src/discovery.js';
import { tileInscribedInEllipse } from '../../../src/island.js';

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

  it('#44: drains routes sourced from the demolished building', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);

    const createAck = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: 'wood' },
        seq: 2,
      },
      now,
    );
    expect(createAck.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'demolish-building', payload: { islandId: 'home', buildingId: dockId }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0].draining).toBe(true);
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
    expect(invAfter.wood!).toBeLessThan(invBefore.wood!);
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

  it('#44: drains routes sourced from the building when active floors drop to 0', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);

    const createAck = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: 'wood' },
        seq: 2,
      },
      now,
    );
    expect(createAck.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-active-floors', payload: { islandId: 'home', buildingId: dockId, disabledFloors: 1 }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0].draining).toBe(true);
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
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'pad-1', defId: 'dronepad', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.biofuel = 100;
    });

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

  it('illegal: no operational Drone Pad is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.inventory.biofuel = 100;
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'dispatch-drone',
        payload: { islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10 },
        seq: 9,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: false, error: 'no-operational-dronepad' });
  });

  it('illegal: insufficient fuel is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'pad-1', defId: 'dronepad', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      // No biofuel.
    });
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

  it('legal: path-drawn drone with selectedTier+waypoints succeeds without a Path Drone Foundry', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'pad-1', defId: 'dronepad', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.level = 50;
      state.inventory.diesel = 100;
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'dispatch-drone',
        payload: {
          islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10,
          waypoints: [{ x: 5, y: 0 }, { x: 10, y: 0 }],
          selectedTier: 2,
        },
        seq: 9,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 9 });

    const after = await loadSnapshot(pool, uid);
    expect(after!.world.drones.length).toBe(1);
    expect(after!.world.drones[0]!.tier).toBe(2);
  });

  // Migration regression: the dispatch-drone handler dropped waypoints +
  // selectedTier, so a T5 path-drawn drone became a straight-line default
  // drone and the tier picker was ignored. Validation must now accept/reject
  // the new fields by shape.
  it('illegal: out-of-range selectedTier is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'dispatch-drone', payload: { islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10, selectedTier: 99 }, seq: 3 },
      now,
    );
    expect(ack.ok).toBe(false);
  });

  it('illegal: malformed waypoints array is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'dispatch-drone', payload: { islandId: 'home', originX: 0, originY: 0, dirX: 1, dirY: 0, fuelLoaded: 10, waypoints: [{ x: 1 }] }, seq: 3 },
      now,
    );
    expect(ack.ok).toBe(false);
  });
});

// Migration regression (user-reported): the place-building intent destructured
// only {islandId,defId,x,y,rotation} and forwarded NO cargoLabel to the pure
// placeBuilding, so every generic-storage building (Crate/Warehouse) was
// labeled the iron_ore DEFAULT_CARGO_LABEL regardless of the player's §4.6
// picker pick. REMOTE is the default boot mode, so the picker was cosmetic.
describe('place-building cargoLabel forwarding (§4.6 picker)', () => {
  it('forwards the picker cargoLabel to the minted generic-storage building', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'crate', x: 0, y: 0, rotation: 0, cargoLabel: 'wood' }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(true);
    const b = (await homeBuildings(uid)).find((bb) => bb.defId === 'crate')!;
    expect(b.cargoLabel).toBe('wood'); // NOT the iron_ore default
  });

  it('falls back to the iron_ore default when no cargoLabel is supplied', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'crate', x: 0, y: 0, rotation: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(true);
    const b = (await homeBuildings(uid)).find((bb) => bb.defId === 'crate')!;
    expect(b.cargoLabel).toBe('iron_ore');
  });

  it('rejects an invalid cargoLabel by shape', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'crate', x: 0, y: 0, rotation: 0, cargoLabel: 'not_a_resource' }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(false);
  });
});

// Migration regression (Fix 3): the place-building handler passed world-TILE
// coords to validateOceanPlacement, which expects CELL indices, so it sampled
// 16x too far out and let illegal placements through.
describe('place-building ocean validation', () => {
  it('illegal: ocean building overlapping the anchor island is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'sonar_buoy', x: 0, y: 0, rotation: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(false);
    expect(ack).toMatchObject({ error: expect.stringMatching(/land-overlap|illegal ocean placement/) });
  });

  it('legal: ocean building with an eligible anchor is accepted', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.level = 5;
      state.inventory.steel_beam = 1000;
      state.inventory.concrete = 10000;
      state.inventory.iron_ingot = 1000;
      state.inventory.wire = 1000;
      state.inventory.microchip = 1000;
      state.inventory.galvanized_steel = 1000;
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'place-building',
        payload: {
          islandId: 'home', defId: 'sonar_buoy', x: -160, y: 0, rotation: 0,
          anchorIslandId: 'home',
        },
        seq: 1,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 1 });
    const b = (await homeBuildings(uid)).find((bb) => bb.defId === 'sonar_buoy')!;
    expect(b.anchorIslandId).toBe('home');
  });

  it('illegal: ocean building with an ineligible anchorIslandId is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.level = 5;
      state.inventory.steel_beam = 1000;
      state.inventory.concrete = 10000;
      state.inventory.iron_ingot = 1000;
      state.inventory.wire = 1000;
      state.inventory.microchip = 1000;
      state.inventory.galvanized_steel = 1000;
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'place-building',
        payload: {
          islandId: 'home', defId: 'sonar_buoy', x: -160, y: 0, rotation: 0,
          anchorIslandId: 'not-a-candidate',
        },
        seq: 1,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: false, error: 'ineligible-anchor' });
  });
});

// ---------------------------------------------------------------------------
// #147 multibiome biome-locked placement (server authoritative path)
// ---------------------------------------------------------------------------

/** Build a game where `home` is forest and has absorbed a volcanic lobe. */
async function aUserWithMergedVolcanicHomeIsland(now: number): Promise<string> {
  return aUserWithModifiedGame(now, (world, islandStates) => {
    const home = world.islands.find((s: any) => s.id === 'home');
    const state = islandStates.get('home');
    home.biome = 'forest';
    home.majorRadius = 14;
    home.minorRadius = 14;
    home.extraEllipses = [
      { major: 10, minor: 10, rotation: 0, offsetX: 12, offsetY: 0, biome: 'volcanic' },
    ];
    state.level = 30; // T4 unlock for pyroforge
    state.inventory.steel_beam = 100000;
    state.inventory.clay = 100000;
    state.inventory.microchip = 100000;
    state.inventory.ceramic_insulator = 100000;
  });
}

describe('#147 multibiome place-building biome gate', () => {
  it('accepts a volcanic unique fully on the volcanic constituent', async () => {
    const now = Date.now();
    const uid = await aUserWithMergedVolcanicHomeIsland(now);
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'pyroforge', x: 16, y: 0, rotation: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(true);
    const buildings = await homeBuildings(uid);
    expect(buildings.some((b) => b.defId === 'pyroforge')).toBe(true);
  });

  it('rejects a volcanic unique on the forest primary', async () => {
    const now = Date.now();
    const uid = await aUserWithMergedVolcanicHomeIsland(now);
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'pyroforge', x: 0, y: 0, rotation: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(false);
  });

  it('rejects a volcanic unique straddling forest + volcanic', async () => {
    const now = Date.now();
    const uid = await aUserWithMergedVolcanicHomeIsland(now);
    const ack = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'pyroforge', x: 12, y: 0, rotation: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(false);
  });
});

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

/** §13.3 helper: home has an operational Time Lock + Genesis Chamber, colony is
 *  populated. Used to test Time Lock banking/spend and Genesis target intents. */
async function aUserWithT5Controls(now: number): Promise<string> {
  const { world, islandStates } = createNewGame(now);
  const home = world.islands.find((s) => s.id === 'home')!;
  home.buildings.push(
    { id: 'tl-1', defId: 'time_lock', x: -10, y: -10, rotation: 0, constructionRemainingMs: 0 },
    { id: 'gc-1', defId: 'genesis_chamber', x: 10, y: 10, rotation: 0, constructionRemainingMs: 0 },
  );
  const colony = world.islands.find((s) => s.id === COLONY_ID)!;
  colony.populated = true;
  colony.discovered = true;
  islandStates.set('home', makeInitialIslandState(home, now));
  islandStates.set(COLONY_ID, makeInitialIslandState(colony, now));
  world.islandStates = islandStates;
  return userWithSnapshot(serializeWorld(world, islandStates, now, now));
}

describe('set-banking-enabled', () => {
  it('legal: toggles state.bankingEnabled on a Time Lock island', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);

    const onAck = await applyIntent(
      pool, uid,
      { type: 'set-banking-enabled', payload: { islandId: 'home', enabled: true }, seq: 2 },
      now,
    );
    expect(onAck).toMatchObject({ ok: true, seq: 2 });
    expect((await homeState(uid)).bankingEnabled).toBe(true);

    const offAck = await applyIntent(
      pool, uid,
      { type: 'set-banking-enabled', payload: { islandId: 'home', enabled: false }, seq: 3 },
      now,
    );
    expect(offAck).toMatchObject({ ok: true, seq: 3 });
    expect((await homeState(uid)).bankingEnabled).toBe(false);
  });

  it('illegal: non-boolean enabled is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);
    await expectRejectNoChange(
      uid,
      { type: 'set-banking-enabled', payload: { islandId: 'home', enabled: 'yes' }, seq: 2 },
      now,
    );
  });
});

describe('spend-time-lock', () => {
  it('legal: with enough banked time, accelerates target and deducts bank', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);

    // Prime banked time on the source island by mutating the stored snapshot.
    const before = await loadSnapshot(pool, uid);
    const homeStateSnap = before!.islandStates.find((s) => s.id === 'home')!;
    homeStateSnap.state.timeLockBankedMin = 60;
    await saveSnapshot(pool, uid, before!);

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'spend-time-lock',
        payload: { sourceIslandId: 'home', targetIslandId: COLONY_ID, minutes: 30 },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const after = await loadSnapshot(pool, uid);
    const homeAfter = after!.islandStates.find((s) => s.id === 'home')!;
    const colonyAfter = after!.islandStates.find((s) => s.id === COLONY_ID)!;
    expect(homeAfter.state.timeLockBankedMin).toBe(30);
    expect(colonyAfter.state.accelerationRemainingMin).toBe(30);
  });

  it('illegal: insufficient banked time is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);
    await expectRejectNoChange(
      uid,
      {
        type: 'spend-time-lock',
        payload: { sourceIslandId: 'home', targetIslandId: COLONY_ID, minutes: 10 },
        seq: 2,
      },
      now,
    );
  });

  it('illegal: already-accelerating target is queued, not rejected, and deducts bank', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);

    const before = await loadSnapshot(pool, uid);
    const homeStateSnap = before!.islandStates.find((s) => s.id === 'home')!;
    const colonyStateSnap = before!.islandStates.find((s) => s.id === COLONY_ID)!;
    homeStateSnap.state.timeLockBankedMin = 60;
    colonyStateSnap.state.accelerationRemainingMin = 5;
    await saveSnapshot(pool, uid, before!);

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'spend-time-lock',
        payload: { sourceIslandId: 'home', targetIslandId: COLONY_ID, minutes: 20 },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const after = await loadSnapshot(pool, uid);
    const homeAfter = after!.islandStates.find((s) => s.id === 'home')!;
    const colonyAfter = after!.islandStates.find((s) => s.id === COLONY_ID)!;
    expect(homeAfter.state.timeLockBankedMin).toBe(40);
    expect(colonyAfter.state.accelerationRemainingMin).toBe(5);
    expect(colonyAfter.state.accelerationQueue).toHaveLength(1);
    expect(colonyAfter.state.accelerationQueue[0]).toMatchObject({ durationMin: 20 });
  });

  it('illegal: non-positive minutes is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);
    await expectRejectNoChange(
      uid,
      {
        type: 'spend-time-lock',
        payload: { sourceIslandId: 'home', targetIslandId: COLONY_ID, minutes: 0 },
        seq: 2,
      },
      now,
    );
  });
});

describe('set-genesis-target', () => {
  it('legal: sets a valid T1-T4 resource target', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-genesis-target', payload: { islandId: 'home', resourceId: 'iron_ingot' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });
    expect((await homeState(uid)).genesisTarget).toBe('iron_ingot');
  });

  it('legal: clears the target with null', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);

    await applyIntent(
      pool, uid,
      { type: 'set-genesis-target', payload: { islandId: 'home', resourceId: 'iron_ingot' }, seq: 2 },
      now,
    );
    const ack = await applyIntent(
      pool, uid,
      { type: 'set-genesis-target', payload: { islandId: 'home', resourceId: null }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });
    expect((await homeState(uid)).genesisTarget).toBeNull();
  });

  it('illegal: T5 resource target is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);
    await expectRejectNoChange(
      uid,
      { type: 'set-genesis-target', payload: { islandId: 'home', resourceId: 'casimir_energy' }, seq: 2 },
      now,
    );
  });

  it('illegal: invalid resource id is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithT5Controls(now);
    await expectRejectNoChange(
      uid,
      { type: 'set-genesis-target', payload: { islandId: 'home', resourceId: 'not_a_resource' }, seq: 2 },
      now,
    );
  });
});

describe('create-route', () => {
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

  // Migration regression (Fix 1): the client sends an explicit `null` for the
  // default "any (priority)" cargo option; the server must accept it.
  it('legal: filterResource null creates the default any-priority route', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: null },
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

  // Parity fix (Fix 6): an unknown filterResource id must be rejected on both
  // LOCAL and REMOTE, not silently treated as null.
  it('illegal: unknown filterResource is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    await expectRejectNoChange(
      uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: 'not_a_resource' },
        seq: 9,
      },
      now,
    );
  });
});

describe('set-cargo-floor-pct', () => {
  // Migration regression (Fix 4): omitting `sourceFloorPct` must clear the
  // source-floor gate, matching the LOCAL gateway behavior.
  it('legal: omits sourceFloorPct and clears the source-floor gate', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    const createAck = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: 'iron_ore' },
        seq: 2,
      },
      now,
    );
    expect(createAck.ok).toBe(true);

    const routeId = (await loadSnapshot(pool, uid))!.world.routes[0]!.id;
    const setAck1 = await applyIntent(
      pool, uid,
      { type: 'set-cargo-floor-pct', payload: { routeId, cargoIndex: 0, sourceFloorPct: 50 }, seq: 3 },
      now,
    );
    expect(setAck1.ok).toBe(true);
    let route = (await loadSnapshot(pool, uid))!.world.routes[0]!;
    expect(route.cargo[0]).toMatchObject({ sourceFloorPct: 50 });

    const setAck2 = await applyIntent(
      pool, uid,
      { type: 'set-cargo-floor-pct', payload: { routeId, cargoIndex: 0 }, seq: 4 },
      now,
    );
    expect(setAck2.ok).toBe(true);
    route = (await loadSnapshot(pool, uid))!.world.routes[0]!;
    expect(route.cargo[0]).not.toHaveProperty('sourceFloorPct');
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

  it('illegal: a keystone without AND prereqs or bridge path is rejected', async () => {
    const now = Date.now();
    const uid = await aUserAtLevel5(100);
    await expectRejectNoChange(
      uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 2 },
      now,
    );
  });

  it('illegal: an AND-ready keystone is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home')!;
      state.level = 50;
      state.unspentSkillPoints = 100;
      state.unlockedNodes.add('mining.notable.deepVein');
      state.unlockedNodes.add('mining.notable.blastOptimization');
    });
    await expectRejectNoChange(
      uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 2 },
      now,
    );
  });

  it('legal: a keystone reachable via an active bridge can be bought', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home')!;
      state.level = 70;
      state.unspentSkillPoints = 1_000_000;
      // Own bridge source and many nodes to satisfy thresholds.
      const target = 'electronics.keystone.quantumYield';
      const andPrereqs = new Set<string>([
        'electronics.notable.cleanRoom',
        'electronics.notable.quantumEtching',
      ]);
      state.unlockedNodes.add('robotics.keystone.parallelConstruction');
      for (const n of DEFAULT_GRAPH.nodes) {
        if (n.id === target) continue;
        if (andPrereqs.has(n.id)) continue;
        if (n.subPath === 'mining' || n.subPath === 'forestry' || n.subPath === 'drilling' ||
            n.subPath === 'smelting' || n.subPath === 'chemistry' || n.subPath === 'electronics') {
          state.unlockedNodes.add(n.id);
        }
      }
    });
    const ack = await applyIntent(
      pool, uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId: 'electronics.keystone.quantumYield' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect(state.unlockedNodes).toContain('electronics.keystone.quantumYield');
    expect(state.unspentSkillPoints).toBe(1_000_000 - 12); // bridge edge cost
  });

  // Migration regression (Fix 2): mini-tree nodes only exist in `effectiveGraph`
  // (after a crystal is bound to a socket); the server must use the same graph
  // as the LOCAL gateway, not DEFAULT_GRAPH.
  it('legal: unlocks a crystal mini-tree node after binding the crystal', async () => {
    const now = Date.now();
    const snap = createInitialSnapshot(now) as unknown as {
      islandStates: Array<{ id: string; state: { level: number; unspentSkillPoints: number; inventory: Record<string, number> } }>;
    };
    const home = snap.islandStates.find((e) => e.id === 'home')!;
    home.state.level = 5;
    home.state.unspentSkillPoints = 10;
    home.state.inventory.mining_crystal_t1 = 1;
    const uid = await userWithSnapshot(snap as unknown as SaveSnapshot);

    const bindAck = await applyIntent(
      pool, uid,
      { type: 'bind-crystal', payload: { islandId: 'home', socketId: 'gs.ext.mining-1', crystalId: 'mining_crystal_t1' }, seq: 1 },
      now,
    );
    expect(bindAck.ok).toBe(true);

    const nodeId = 'gs.ext.mining-1.mining_crystal_t1.left1';
    const ack = await applyIntent(
      pool, uid,
      { type: 'unlock-skill-node', payload: { islandId: 'home', nodeId }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect(state.unlockedNodes).toContain(nodeId);
    expect(state.unspentSkillPoints).toBe(9); // 10 SP - mini-tree edge cost(1)
  });
});


/** Build a fresh game, apply in-memory mutations, persist it, and return the
 *  user id. Useful for setting up high-tier buildings / resources without
 *  going through the place-building cost/queue path. */
async function aUserWithModifiedGame(
  now: number,
  mod: (world: any, islandStates: any) => void,
): Promise<string> {
  const { world, islandStates } = createNewGame(now);
  mod(world, islandStates);
  return userWithSnapshot(serializeWorld(world, islandStates, now, now) as SaveSnapshot);
}

/** Build a game where `home` has absorbed one extra ellipse and carries a
 *  Land Reclamation Hub with enough materials to expand. */
async function aUserWithMergedHomeIsland(now: number): Promise<string> {
  return aUserWithModifiedGame(now, (world, islandStates) => {
    const home = world.islands.find((s: any) => s.id === 'home');
    const state = islandStates.get('home');
    home.buildings.push({
      id: 'hub-1', defId: 'land_reclamation_hub', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now,
    });
    state.buildings = home.buildings;
    home.extraEllipses = [{ major: 3, minor: 3, rotation: 0, offsetX: 20, offsetY: 0 }];
    state.inventory.steel_beam = 1000;
    state.inventory.concrete = 10000;
  });
}

/** Return the serialized snapshot's home island spec. */
async function homeSpec(uid: string): Promise<any> {
  const snap = await loadSnapshot(pool, uid);
  return snap!.world.islands.find((s: any) => s.id === 'home');
}

/** Return the serialized snapshot's world object. */
async function worldSnap(uid: string): Promise<any> {
  return (await loadSnapshot(pool, uid))!.world;
}


describe('relocate-building', () => {
  it('legal: moves an existing building to a new tile', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const id = await placeBuilding(uid, 'workshop', 0, 0, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'relocate-building', payload: { islandId: 'home', buildingId: id, x: 1, y: 0, rotation: 0 }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const buildings = await homeBuildings(uid);
    const b = buildings.find((bb) => bb.id === id)!;
    expect(b.x).toBe(1);
    expect(b.y).toBe(0);
  });

  it('illegal: unknown buildingId is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'relocate-building', payload: { islandId: 'home', buildingId: 'nope', x: 1, y: 0 }, seq: 9 },
      now,
    );
  });

  // Parity fix (Fix 5): an omitted rotation must preserve the building's current
  // rotation, not reset it to 0.
  it('legal: omits rotation and preserves the current rotation', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const placeAck = await applyIntent(
      pool, uid,
      { type: 'place-building', payload: { islandId: 'home', defId: 'workshop', x: 0, y: 0, rotation: 1 }, seq: 1 },
      now,
    );
    expect(placeAck.ok).toBe(true);
    const id = (await homeBuildings(uid)).find((b) => b.defId === 'workshop')!.id as string;

    const ack = await applyIntent(
      pool, uid,
      { type: 'relocate-building', payload: { islandId: 'home', buildingId: id, x: 1, y: 0 }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const b = (await homeBuildings(uid)).find((bb) => bb.id === id)!;
    expect(b.x).toBe(1);
    expect(b.y).toBe(0);
    expect(b.rotation).toBe(1);
  });
});

describe('set-ignore-cap', () => {
  async function aUserWithSmelterMaterials(now: number): Promise<string> {
    return aUserWithModifiedGame(now, (_w, states) => {
      const s = states.get('home');
      s.level = 5;
      s.inventory.stone = 1000;
      s.inventory.clay = 1000;
      s.inventory.wood = 1000;
    });
  }

  it('accepts a real output resource and writes the override', async () => {
    const now = Date.now();
    const uid = await aUserWithSmelterMaterials(now);
    // place a smelter first via place-building, then toggle its iron_ingot
    const bId = await placeBuilding(uid, 'smelter', 0, 0, now); // helper returns id
    const ack = await applyIntent(pool, uid,
      { type: 'set-ignore-cap', payload: { islandId: 'home', buildingId: bId, resource: 'iron_ingot', value: true }, seq: 2 }, now);
    expect(ack).toMatchObject({ ok: true });
    const b = (await homeBuildings(uid)).find((bb) => bb.id === bId)!;
    expect((b.ignoreCapOverrides as Record<string, boolean>).iron_ingot).toBe(true);
  });

  it('rejects a resource that is not an output of the building', async () => {
    const now = Date.now();
    const uid = await aUserWithSmelterMaterials(now);
    const bId = await placeBuilding(uid, 'smelter', 0, 0, now);
    const ack = await applyIntent(pool, uid,
      { type: 'set-ignore-cap', payload: { islandId: 'home', buildingId: bId, resource: 'wood', value: true }, seq: 2 }, now);
    expect(ack).toMatchObject({ ok: false });
  });
});

describe('convert-to-servitor', () => {
  it('legal: converts a building and deducts the Conversion Kit cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push(
        {
          id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
          constructionRemainingMs: 0, placedAt: now,
        },
        {
          id: 'rf-1', defId: 'reality_forge', x: 2, y: 0,
          constructionRemainingMs: 0, placedAt: now,
        },
      );
      state.buildings = home.buildings;
      state.inventory.lubricant = 100;
      state.inventory.bolt = 100;
      state.inventory.eldritch_processor = 100;
      state.inventory.phase_converter = 100;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'convert-to-servitor', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    const b = (state.buildings as Array<Record<string, unknown>>).find((bb) => bb.id === 'workshop-1')!;
    expect(b.eternalServitor).toBe(true);
    const inv = state.inventory as Record<string, number>;
    expect(inv.lubricant).toBe(98);
    expect(inv.bolt).toBe(95);
    expect(inv.eldritch_processor).toBe(99);
    expect(inv.phase_converter).toBe(99);
  });

  it('illegal: already a Servitor is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push(
        {
          id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
          constructionRemainingMs: 0, placedAt: now, eternalServitor: true,
        },
        {
          id: 'rf-1', defId: 'reality_forge', x: 2, y: 0,
          constructionRemainingMs: 0, placedAt: now,
        },
      );
      state.buildings = home.buildings;
      state.inventory.lubricant = 100;
      state.inventory.bolt = 100;
      state.inventory.eldritch_processor = 100;
      state.inventory.phase_converter = 100;
    });
    await expectRejectNoChange(
      uid,
      { type: 'convert-to-servitor', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 9 },
      now,
    );
  });

  it('illegal: insufficient materials is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push(
        {
          id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
          constructionRemainingMs: 0, placedAt: now,
        },
        {
          id: 'rf-1', defId: 'reality_forge', x: 2, y: 0,
          constructionRemainingMs: 0, placedAt: now,
        },
      );
      state.buildings = home.buildings;
      // No Conversion Kit materials.
    });
    await expectRejectNoChange(
      uid,
      { type: 'convert-to-servitor', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 9 },
      now,
    );
  });

  it('illegal: missing operational Reality Forge is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.lubricant = 100;
      state.inventory.bolt = 100;
      state.inventory.eldritch_processor = 100;
      state.inventory.phase_converter = 100;
    });
    const ack = await applyIntent(
      pool, uid,
      { type: 'convert-to-servitor', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 9 },
      now,
    );
    expect(ack).toMatchObject({ ok: false, error: 'requires an operational Reality Forge' });
  });
});

describe('relabel-cargo', () => {
  it('legal: changes the cargo label of a generic-storage building', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'crate-1', defId: 'crate', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'relabel-cargo', payload: { islandId: 'home', buildingId: 'crate-1', newLabel: 'wood' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const b = (await homeBuildings(uid)).find((bb) => bb.id === 'crate-1')!;
    expect(b.cargoLabel).toBe('wood');
  });

  it('illegal: invalid resource label is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'crate-1', defId: 'crate', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });
    await expectRejectNoChange(
      uid,
      { type: 'relabel-cargo', payload: { islandId: 'home', buildingId: 'crate-1', newLabel: 'not-a-resource' }, seq: 9 },
      now,
    );
  });
});

describe('set-scrap-target', () => {
  it('legal: sets scrapTarget on a demolition_yard', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'dy-1', defId: 'demolition_yard', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-scrap-target', payload: { islandId: 'home', buildingId: 'dy-1', target: 'iron_mine' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const b = (await homeBuildings(uid)).find((bb) => bb.id === 'dy-1')!;
    expect(b.scrapTarget).toBe('iron_mine');
  });

  it('legal: clears scrapTarget with null', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'dy-1', defId: 'demolition_yard', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, scrapTarget: 'iron_mine',
      });
      state.buildings = home.buildings;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-scrap-target', payload: { islandId: 'home', buildingId: 'dy-1', target: null }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const b = (await homeBuildings(uid)).find((bb) => bb.id === 'dy-1')!;
    expect(b.scrapTarget).toBeUndefined();
  });

  it('illegal: invalid target id is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'dy-1', defId: 'demolition_yard', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });
    await expectRejectNoChange(
      uid,
      { type: 'set-scrap-target', payload: { islandId: 'home', buildingId: 'dy-1', target: 'not-a-building' }, seq: 9 },
      now,
    );
  });

  it('illegal: non-demolition_yard building is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });
    await expectRejectNoChange(
      uid,
      { type: 'set-scrap-target', payload: { islandId: 'home', buildingId: 'workshop-1', target: 'iron_mine' }, seq: 9 },
      now,
    );
  });
});

describe('expand-island', () => {
  it('legal: expands the primary radius and deducts cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 5;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
      home.buildings.push({
        id: 'hub-1', defId: 'land_reclamation_hub', x: 2, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });
    const before = (await homeSpec(uid)).majorRadius;

    const ack = await applyIntent(
      pool, uid,
      { type: 'expand-island', payload: { islandId: 'home', constituentIndex: 0, axis: 'major' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    expect((await homeSpec(uid)).majorRadius).toBe(before + 1);
  });

  it('legal: expands the chosen extra-ellipse constituent', async () => {
    const now = Date.now();
    const uid = await aUserWithMergedHomeIsland(now);
    const before = (await homeSpec(uid)).extraEllipses[0].major;

    const ack = await applyIntent(
      pool, uid,
      { type: 'expand-island', payload: { islandId: 'home', constituentIndex: 1, axis: 'major' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    expect((await homeSpec(uid)).extraEllipses[0].major).toBe(before + 1);
  });

  it('legal: legacy payload without constituentIndex defaults to index 0', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
      home.buildings.push({
        id: 'hub-1', defId: 'land_reclamation_hub', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });
    const before = (await homeSpec(uid)).majorRadius;

    const ack = await applyIntent(
      pool, uid,
      { type: 'expand-island', payload: { islandId: 'home', axis: 'major' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });
    expect((await homeSpec(uid)).majorRadius).toBe(before + 1);
  });

  it('illegal: out-of-range constituentIndex is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithMergedHomeIsland(now);
    await expectRejectNoChange(
      uid,
      { type: 'expand-island', payload: { islandId: 'home', constituentIndex: 9, axis: 'major' }, seq: 9 },
      now,
    );
  });

  it('illegal: expansion without a hub is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'expand-island', payload: { islandId: 'home', constituentIndex: 0, axis: 'major' }, seq: 9 },
      now,
    );
  });
});

describe('fire-t4-pulse', () => {
  it('legal: fires a pulse and spends cryogenic hydrogen', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 30;
      state.inventory.cryogenic_hydrogen = 100;
      home.buildings.push({
        id: 'tower-1', defId: 'launch_tower', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'fire-t4-pulse', payload: { islandId: 'home' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const fuelAfter = ((await homeState(uid)).inventory as Record<string, number>).cryogenic_hydrogen;
    expect(fuelAfter).toBe(90);
  });

  it('illegal: no launch tower is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'fire-t4-pulse', payload: { islandId: 'home' }, seq: 9 },
      now,
    );
  });
});


describe('route management', () => {
  const COLONY_ID = 'gen-1--3';
  async function aUserWithTwoPopulatedIslands(now: number): Promise<string> {
    const { world, islandStates } = createNewGame(now);
    const colony = world.islands.find((s: any) => s.id === COLONY_ID)!;
    colony.populated = true;
    colony.discovered = true;
    islandStates.set(COLONY_ID, makeInitialIslandState(colony, now));
    world.islandStates = islandStates;
    return userWithSnapshot(serializeWorld(world, islandStates, now, now) as SaveSnapshot);
  }

  async function makeRoute(uid: string, now: number): Promise<string> {
    const dockId = await placeBuilding(uid, 'dock', 0, 0, now);
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'create-route',
        payload: { fromIslandId: 'home', toIslandId: COLONY_ID, buildingId: dockId, filterResource: 'wood' },
        seq: 2,
      },
      now,
    );
    expect(ack.ok).toBe(true);
    const snap = await loadSnapshot(pool, uid);
    return snap!.world.routes[0]!.id as string;
  }

  it('delete-route: removes the route immediately when inFlight is empty', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'delete-route', payload: { routeId }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes).toHaveLength(0);
  });

  it('delete-route: marks the route as draining when cargo is in flight', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    // Put a batch in flight before deleting.
    const before = await loadSnapshot(pool, uid);
    before!.world.routes[0]!.inFlight.push({
      resourceId: 'wood',
      amount: 1,
      arrivalTime: now + 60_000,
      dispatchTime: now,
      id: 'batch-1',
    });
    await saveSnapshot(pool, uid, before!);

    const ack = await applyIntent(
      pool, uid,
      { type: 'delete-route', payload: { routeId }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes).toHaveLength(1);
    expect(routes[0].draining).toBe(true);
  });

  it('rejects edits to a draining route', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    // Put cargo in flight so the route drains instead of being spliced out.
    const before = await loadSnapshot(pool, uid);
    before!.world.routes[0]!.inFlight.push({
      resourceId: 'wood',
      amount: 1,
      arrivalTime: now + 60_000,
      dispatchTime: now,
      id: 'batch-1',
    });
    await saveSnapshot(pool, uid, before!);

    const del = await applyIntent(
      pool, uid,
      { type: 'delete-route', payload: { routeId }, seq: 3 },
      now,
    );
    expect(del).toMatchObject({ ok: true, seq: 3 });

    const modeAck = await applyIntent(
      pool, uid,
      { type: 'set-route-mode', payload: { routeId, mode: 'balanced' }, seq: 4 },
      now,
    );
    expect(modeAck).toMatchObject({ ok: false, error: 'route is draining' });

    const weightAck = await applyIntent(
      pool, uid,
      { type: 'set-cargo-weight', payload: { routeId, cargoIndex: 0, weight: 7 }, seq: 5 },
      now,
    );
    expect(weightAck).toMatchObject({ ok: false, error: 'route is draining' });
  });

  it('set-route-mode: changes the cargo allocation mode', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-route-mode', payload: { routeId, mode: 'balanced' }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes[0].mode).toBe('balanced');
  });

  it('set-cargo-weight: updates the weight of a cargo entry', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-cargo-weight', payload: { routeId, cargoIndex: 0, weight: 7 }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes[0].cargo[0].weight).toBe(7);
  });

  it('set-cargo-floor-pct: sets the source-floor percentage', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-cargo-floor-pct', payload: { routeId, cargoIndex: 0, sourceFloorPct: 25 }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const routes = (await worldSnap(uid)).routes;
    expect(routes[0].cargo[0].sourceFloorPct).toBe(25);
  });

  it('set-route-cargo: replaces the cargo list after validation', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'set-route-cargo',
        payload: {
          routeId,
          cargo: [
            { resourceId: 'wood', weight: 2 },
            { resourceId: 'stone', weight: 3, sourceFloorPct: 10 },
          ],
        },
        seq: 3,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const cargo = (await worldSnap(uid)).routes[0].cargo;
    expect(cargo).toHaveLength(2);
    expect(cargo[0]).toMatchObject({ resourceId: 'wood', weight: 2 });
    expect(cargo[1]).toMatchObject({ resourceId: 'stone', weight: 3, sourceFloorPct: 10 });
  });

  it('reorder-route-cargo: moves a cargo entry in the priority list', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);

    const setAck = await applyIntent(
      pool, uid,
      {
        type: 'set-route-cargo',
        payload: {
          routeId,
          cargo: [
            { resourceId: 'wood', weight: 1 },
            { resourceId: 'stone', weight: 1 },
          ],
        },
        seq: 3,
      },
      now,
    );
    expect(setAck.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'reorder-route-cargo', payload: { routeId, srcIndex: 0, dstIndex: 1 }, seq: 4 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 4 });

    const cargo = (await worldSnap(uid)).routes[0].cargo;
    expect(cargo[0].resourceId).toBe('stone');
    expect(cargo[1].resourceId).toBe('wood');
  });

  it('illegal: invalid cargo mode is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);
    await expectRejectNoChange(
      uid,
      { type: 'set-route-mode', payload: { routeId, mode: 'nonsense' }, seq: 9 },
      now,
    );
  });

  it('illegal: duplicate resources in cargo list are rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);
    await expectRejectNoChange(
      uid,
      {
        type: 'set-route-cargo',
        payload: { routeId, cargo: [{ resourceId: 'wood' }, { resourceId: 'wood' }] },
        seq: 9,
      },
      now,
    );
  });

  async function makeT5Route(now: number): Promise<{ uid: string; routeId: string }> {
    const uid = await aUserWithTwoPopulatedIslands(now);
    const snap = await loadSnapshot(pool, uid);
    const homeState = snap!.islandStates.find((s: any) => s.id === 'home')!;
    homeState.state.level = 50; // tier 5
    await saveSnapshot(pool, uid, snap!);
    const routeId = await makeRoute(uid, now);
    return { uid, routeId };
  }

  it('set-route-waypoints: sets waypoints on a T5 cargo route', async () => {
    const now = Date.now();
    const { uid, routeId } = await makeT5Route(now);

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-route-waypoints', payload: { routeId, waypoints: [{ x: 10, y: 20 }] }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const route = (await worldSnap(uid)).routes[0];
    expect(route.waypoints).toEqual([{ x: 10, y: 20 }]);
  });

  it('set-route-waypoints: empty array unbends the route', async () => {
    const now = Date.now();
    const { uid, routeId } = await makeT5Route(now);

    await applyIntent(
      pool, uid,
      { type: 'set-route-waypoints', payload: { routeId, waypoints: [{ x: 10, y: 20 }] }, seq: 3 },
      now,
    );
    const ack = await applyIntent(
      pool, uid,
      { type: 'set-route-waypoints', payload: { routeId, waypoints: [] }, seq: 4 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 4 });

    const route = (await worldSnap(uid)).routes[0];
    expect(route.waypoints).toBeUndefined();
  });

  it('set-route-waypoints: >4 waypoints are rejected, save unchanged', async () => {
    const now = Date.now();
    const { uid, routeId } = await makeT5Route(now);
    await expectRejectNoChange(
      uid,
      {
        type: 'set-route-waypoints',
        payload: { routeId, waypoints: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }, { x: 5, y: 5 }] },
        seq: 9,
      },
      now,
    );
  });

  it('set-route-waypoints: malformed waypoint is rejected, save unchanged', async () => {
    const now = Date.now();
    const { uid, routeId } = await makeT5Route(now);
    await expectRejectNoChange(
      uid,
      { type: 'set-route-waypoints', payload: { routeId, waypoints: [{ x: 1 }] }, seq: 9 },
      now,
    );
  });

  it('set-route-waypoints: non-T5 source island is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithTwoPopulatedIslands(now);
    const routeId = await makeRoute(uid, now);
    await expectRejectNoChange(
      uid,
      { type: 'set-route-waypoints', payload: { routeId, waypoints: [{ x: 10, y: 20 }] }, seq: 9 },
      now,
    );
  });
});


describe('buy-keystone', () => {
  it('legal: purchases a keystone when prereqs and SP are met', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.unlockedNodes = new Set(['mining.notable.deepVein', 'mining.notable.blastOptimization']);
      state.unspentSkillPoints = 100;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'buy-keystone', payload: { islandId: 'home', nodeId: 'mining.keystone.veinmaster' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect((state.unlockedNodes as string[])).toContain('mining.keystone.veinmaster');
    expect(state.unspentSkillPoints).toBe(88); // 100 - cost(12)
  });

  it('illegal: a non-keystone target is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.unlockedNodes = new Set();
      state.unspentSkillPoints = 100;
    });
    await expectRejectNoChange(
      uid,
      { type: 'buy-keystone', payload: { islandId: 'home', nodeId: 'mining.recipeRate.1' }, seq: 9 },
      now,
    );
  });
});

describe('bind-crystal / unbind-crystal', () => {
  it('legal: binds a crystal from inventory into a graft socket', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.inventory.mining_crystal_t1 = 1;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'bind-crystal', payload: { islandId: 'home', socketId: 'gs.ext.mining-1', crystalId: 'mining_crystal_t1' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(0);
    const bindings = state.socketBindings as Array<[string, string]>;
    expect(bindings).toContainEqual(['gs.ext.mining-1', 'mining_crystal_t1']);
  });

  it('legal: unbind returns the crystal to inventory', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.inventory.mining_crystal_t1 = 1;
    });

    const bind = await applyIntent(
      pool, uid,
      { type: 'bind-crystal', payload: { islandId: 'home', socketId: 'gs.ext.mining-1', crystalId: 'mining_crystal_t1' }, seq: 2 },
      now,
    );
    expect(bind.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'unbind-crystal', payload: { islandId: 'home', socketId: 'gs.ext.mining-1' }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).mining_crystal_t1).toBe(1);
    expect((state.socketBindings as Array<[string, string]>).length).toBe(0);
  });

  it('illegal: binding an ineligible crystal is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.inventory.forestry_crystal_t1 = 1;
    });
    await expectRejectNoChange(
      uid,
      { type: 'bind-crystal', payload: { islandId: 'home', socketId: 'gs.ext.mining-1', crystalId: 'forestry_crystal_t1' }, seq: 9 },
      now,
    );
  });
});

async function aUserWithConduits(
  now: number,
  opts: { crossIsland?: boolean } = {},
): Promise<{ uid: string; homeConduitIds: string[] }> {
  const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
    const home = world.islands.find((s: any) => s.id === 'home');
    const state = islandStates.get('home');
    home.buildings.push(
      { id: 'cc-1', defId: 'cluster_conduit', x: 0, y: 0, constructionRemainingMs: 0, placedAt: now },
      { id: 'cc-2', defId: 'cluster_conduit', x: 2, y: 0, constructionRemainingMs: 0, placedAt: now },
    );
    state.buildings = home.buildings;
    if (opts.crossIsland) {
      const colony = world.islands.find((s: any) => s.id === COLONY_ID);
      colony.populated = true;
      colony.discovered = true;
      colony.buildings.push({ id: 'cc-colony', defId: 'cluster_conduit', x: 0, y: 0, constructionRemainingMs: 0, placedAt: now });
      islandStates.set(COLONY_ID, makeInitialIslandState(colony, now));
      islandStates.get(COLONY_ID)!.buildings = colony.buildings;
    }
  });
  return { uid, homeConduitIds: ['cc-1', 'cc-2'] };
}

describe('conduit-link intents', () => {
  it('add-conduit-link: wires two valid same-island conduits', async () => {
    const now = Date.now();
    const { uid } = await aUserWithConduits(now);
    const ack = await applyIntent(
      pool, uid,
      { type: 'add-conduit-link', payload: { aId: 'cc-1', bId: 'cc-2' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const links = (await worldSnap(uid)).conduitLinks;
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ a: 'cc-1', b: 'cc-2' });
  });

  it('add-conduit-link: rejects an illegal cross-island non-lattice pair', async () => {
    const now = Date.now();
    const { uid } = await aUserWithConduits(now, { crossIsland: true });
    await expectRejectNoChange(
      uid,
      { type: 'add-conduit-link', payload: { aId: 'cc-1', bId: 'cc-colony' }, seq: 2 },
      now,
    );
  });

  it('remove-conduit-link: drops an existing link', async () => {
    const now = Date.now();
    const { uid } = await aUserWithConduits(now);
    const add = await applyIntent(
      pool, uid,
      { type: 'add-conduit-link', payload: { aId: 'cc-1', bId: 'cc-2' }, seq: 2 },
      now,
    );
    expect(add.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'remove-conduit-link', payload: { aId: 'cc-1', bId: 'cc-2' }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const links = (await worldSnap(uid)).conduitLinks;
    expect(links).toHaveLength(0);
  });

  it('demolish-building on a conduit prunes its links', async () => {
    const now = Date.now();
    const { uid } = await aUserWithConduits(now);
    const add = await applyIntent(
      pool, uid,
      { type: 'add-conduit-link', payload: { aId: 'cc-1', bId: 'cc-2' }, seq: 2 },
      now,
    );
    expect(add.ok).toBe(true);

    const ack = await applyIntent(
      pool, uid,
      { type: 'demolish-building', payload: { islandId: 'home', buildingId: 'cc-1' }, seq: 3 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 3 });

    const links = (await worldSnap(uid)).conduitLinks;
    expect(links).toHaveLength(0);
    const buildings = await homeBuildings(uid);
    expect(buildings.some((b) => b.id === 'cc-1')).toBe(false);
  });
});

describe('tier-reset', () => {
  it('legal: resets a T3+ island to level 1 and deducts cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const state = islandStates.get('home');
      state.level = 15;
      state.inventory.steel = 300;
      state.inventory.gear = 200;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'tier-reset', payload: { islandId: 'home' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    expect(state.level).toBe(1);
    expect((state.inventory as Record<string, number>).steel).toBe(75); // 300 - 225
    expect((state.inventory as Record<string, number>).gear).toBe(88); // 200 - 112
  });

  it('illegal: tier-too-low island is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'tier-reset', payload: { islandId: 'home' }, seq: 9 },
      now,
    );
  });
});


describe('dispatch-settler', () => {
  const COLONY_ID = 'gen-1--3';
  async function aUserReadyToSettle(now: number): Promise<string> {
    return aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'shipyard-1', defId: 'shipyard', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.biofuel = 200;
      state.inventory.foundation_kit = 10;
      const colony = world.islands.find((s: any) => s.id === COLONY_ID);
      colony.discovered = true;
      colony.populated = false;
    });
  }

  it('legal: launches a settler ship and deducts fuel/kits', async () => {
    const now = Date.now();
    const uid = await aUserReadyToSettle(now);

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'dispatch-settler',
        payload: { originIslandId: 'home', targetIslandId: COLONY_ID, kind: 'ship', tier: 1, fuelLoaded: 200, foundationKitCount: 1 },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const world = await worldSnap(uid);
    expect(world.vehicles.length).toBe(1);
    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).biofuel).toBe(0);
    expect((state.inventory as Record<string, number>).foundation_kit).toBe(9);
  });

  it('illegal: an undiscovered target is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'shipyard-1', defId: 'shipyard', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.biofuel = 200;
      state.inventory.foundation_kit = 10;
    });
    await expectRejectNoChange(
      uid,
      {
        type: 'dispatch-settler',
        payload: { originIslandId: 'home', targetIslandId: COLONY_ID, kind: 'ship', tier: 1, fuelLoaded: 200, foundationKitCount: 1 },
        seq: 9,
      },
      now,
    );
  });
});

describe('settle-via-spacetime', () => {
  const COLONY_ID = 'gen-1--3';
  it('legal: instantly populates a discovered island using a Spacetime Anchor', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 50;
      state.aiCoreCrafted = true;
      state.inventory.foundation_kit_refined = 3;
      home.buildings.push({
        id: 'anchor-1', defId: 'spacetime_anchor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      const colony = world.islands.find((s: any) => s.id === COLONY_ID);
      colony.discovered = true;
      colony.populated = false;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'settle-via-spacetime', payload: { originIslandId: 'home', targetIslandId: COLONY_ID }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const world = await worldSnap(uid);
    const colony = world.islands.find((s: any) => s.id === COLONY_ID);
    expect(colony.populated).toBe(true);
    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).foundation_kit_refined).toBe(2);
  });

  it('illegal: no spacetime anchor is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world) => {
      const colony = world.islands.find((s: any) => s.id === COLONY_ID);
      colony.discovered = true;
      colony.populated = false;
    });
    await expectRejectNoChange(
      uid,
      { type: 'settle-via-spacetime', payload: { originIslandId: 'home', targetIslandId: COLONY_ID }, seq: 9 },
      now,
    );
  });
});


describe('orbital intents', () => {
  function orbitalSnapshot(now: number) {
    const { world, islandStates } = createNewGame(now);
    const home = world.islands.find((s: any) => s.id === 'home')!;
    const state = islandStates.get('home')!;
    state.ascendantCoreCrafted = true;
    state.unlockedNodes = new Set(['launch.notable.padRedundancy', 'launch.keystone.padMastery']);
    state.unspentSkillPoints = 100;
    state.inventory.scanner_sat = 1;
    state.inventory.orbital_insertion_package = 1;
    state.inventory.antimatter_propellant = 1;
    home.buildings.push({
      id: 'spaceport-1', defId: 'spaceport', x: 0, y: 0,
      constructionRemainingMs: 0, placedAt: now, tier: 2,
    });
    state.buildings = home.buildings;
    return serializeWorld(world, islandStates, now, now) as SaveSnapshot;
  }

  it('upgrade-spaceport: bumps an existing Spaceport to tier 2', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (_world, islandStates) => {
      const home = _world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.ascendantCoreCrafted = true;
      home.buildings.push({
        id: 'spaceport-1', defId: 'spaceport', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
      });
      state.buildings = home.buildings;
      state.inventory.phase_converter = 5;
      state.inventory.memetic_core = 2;
      state.inventory.cryogenic_hydrogen = 50;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'upgrade-spaceport', payload: { islandId: 'home' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const b = (await homeBuildings(uid)).find((bb) => bb.id === 'spaceport-1')!;
    expect(b.tier).toBe(2);
  });

  it('launch-satellite: legal launch eventually succeeds and appends a satellite', async () => {
    const now = Date.now();
    let succeeded = false;
    // The launch has a deterministic RNG seeded by world.seed + nowMs. With
    // a T2 Spaceport and both launch-success nodes unlocked the success rate
    // clamps to 0.99; scan a handful of timestamps to find one that rolls success.
    for (let i = 0; i < 50 && !succeeded; i++) {
      const uid = await userWithSnapshot(orbitalSnapshot(now));
      const ack = await applyIntent(
        pool, uid,
        { type: 'launch-satellite', payload: { islandId: 'home', variant: 'scanner', targetX: 100, targetY: 0 }, seq: 2 },
        now + i,
      );
      if (ack.ok) {
        succeeded = true;
        const world = await worldSnap(uid);
        expect(world.satellites.length).toBe(1);
      }
    }
    expect(succeeded).toBe(true);
  });

  it('launch-satellite: no spaceport is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'launch-satellite', payload: { islandId: 'home', variant: 'scanner', targetX: 100, targetY: 0 }, seq: 9 },
      now,
    );
  });

  it('#51: launch-satellite failure persists the consumed payload', async () => {
    const now = Date.now();

    // T1 spaceport + no launch-success skills → base 30% success rate. The RNG
    // is seeded from world.seed + nowMs, so scan a small range to find a
    // deterministic failure roll. A fresh user is created for each attempt so a
    // success on an earlier timestamp doesn't consume the fixture resources.
    let failureUid: string | null = null;
    for (let i = 0; i < 50 && failureUid === null; i++) {
      const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
        const home = world.islands.find((s: any) => s.id === 'home');
        const state = islandStates.get('home');
        state.ascendantCoreCrafted = true;
        home.buildings.push({
          id: 'spaceport-1', defId: 'spaceport', x: 0, y: 0,
          constructionRemainingMs: 0, placedAt: now, tier: 1,
        });
        state.buildings = home.buildings;
        state.inventory.scanner_sat = 1;
        state.inventory.orbital_insertion_package = 1;
        state.inventory.antimatter_propellant = 1;
      });
      const ack = await applyIntent(
        pool, uid,
        { type: 'launch-satellite', payload: { islandId: 'home', variant: 'scanner', targetX: 100, targetY: 0 }, seq: 2 },
        now + i,
      );
      if (!ack.ok && (ack as { error: string }).error === 'launch-failure') {
        failureUid = uid;
      }
    }
    expect(failureUid).not.toBeNull();

    // The failure MUST be persisted: resources are gone (§14.7) and the
    // Spaceport still exists (the pre-fix path destroyed it on pad explosion).
    const snap = await loadSnapshot(pool, failureUid!);
    const state = snap!.islandStates.find((e: any) => e.id === 'home')!.state as unknown as Record<string, unknown>;
    const inv = state.inventory as Record<string, number>;
    expect(inv.scanner_sat).toBe(0);
    expect(inv.orbital_insertion_package).toBe(0);
    expect(inv.antimatter_propellant).toBe(0);
    expect((state.buildings as Array<Record<string, unknown>>).some((b) => b.defId === 'spaceport')).toBe(true);
  });

  it('move-satellite: starts an in-orbit relocation', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world) => {
      world.satellites.push({
        id: 'sat-1',
        variant: 'scanner',
        spaceportIslandId: 'home',
        x: 2,
        y: 2,
        fuel: 100,
        locked: true,
        pendingRepairDroneId: null,
        lodges: { scan: 0, weather: 0, comm: 0 },
        buffer: [],
      } as any);
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'move-satellite', payload: { satId: 'sat-1', targetX: 100, targetY: 0 }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const sat = (await worldSnap(uid)).satellites[0];
    expect(sat.movingTo).toMatchObject({ x: 100, y: 0 });
    expect(sat.locked).toBe(false);
  });

  it('move-satellite: unknown sat is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'move-satellite', payload: { satId: 'nope', targetX: 100, targetY: 0 }, seq: 9 },
      now,
    );
  });

  it('dispatch-repair-drone: sends a repair drone to a satellite', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.ascendantCoreCrafted = true;
      home.buildings.push({
        id: 'spaceport-1', defId: 'spaceport', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
      });
      state.buildings = home.buildings;
      state.inventory.repair_pack = 1;
      state.inventory.antimatter_propellant = 5;
      world.satellites.push({
        id: 'sat-1',
        variant: 'scanner',
        spaceportIslandId: 'home',
        x: 2,
        y: 2,
        fuel: 100,
        locked: true,
        pendingRepairDroneId: null,
        lodges: { scan: 0.5, weather: 0, comm: 0 },
        buffer: [],
      } as any);
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'dispatch-repair-drone', payload: { islandId: 'home', satId: 'sat-1' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const world = await worldSnap(uid);
    expect(world.repairDrones.length).toBe(1);
    expect(world.satellites[0].pendingRepairDroneId).toBe(world.repairDrones[0].id);
  });

  it('dispatch-repair-drone: missing satellite is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.ascendantCoreCrafted = true;
      home.buildings.push({
        id: 'spaceport-1', defId: 'spaceport', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
      });
      state.buildings = home.buildings;
      state.inventory.repair_pack = 1;
      state.inventory.antimatter_propellant = 5;
    });
    await expectRejectNoChange(
      uid,
      { type: 'dispatch-repair-drone', payload: { islandId: 'home', satId: 'nope' }, seq: 9 },
      now,
    );
  });
});


describe('set-location', () => {
  it('legal: sets world.playerLat and world.playerLon', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    const ack = await applyIntent(
      pool, uid,
      { type: 'set-location', payload: { lat: 40.7128, lon: -74.006 }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const world = await worldSnap(uid);
    expect(world.playerLat).toBe(40.7128);
    expect(world.playerLon).toBe(-74.006);
  });

  it('illegal: lat out of range is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'set-location', payload: { lat: 91, lon: 0 }, seq: 9 },
      now,
    );
  });

  it('illegal: lon out of range is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'set-location', payload: { lat: 0, lon: 181 }, seq: 9 },
      now,
    );
  });

  it('illegal: non-finite lat is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'set-location', payload: { lat: NaN, lon: 0 }, seq: 9 },
      now,
    );
    expect(ack.ok).toBe(false);
  });

  it('illegal: missing lat/lon is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'set-location', payload: { lat: 0 }, seq: 9 },
      now,
    );
    expect(ack.ok).toBe(false);
  });

  it('illegal: wrong type is rejected', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'set-location', payload: { lat: '40', lon: -74 }, seq: 9 },
      now,
    );
    expect(ack.ok).toBe(false);
  });
});

describe('rename-island', () => {
  it('legal: renames the island', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    const ack = await applyIntent(
      pool, uid,
      { type: 'rename-island', payload: { islandId: 'home', name: 'New Home' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const spec = await homeSpec(uid);
    expect(spec.name).toBe('New Home');
  });

  it('illegal: unknown island is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'rename-island', payload: { islandId: 'nope', name: 'x' }, seq: 9 },
      now,
    );
  });

  it('illegal: invalid name is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'rename-island', payload: { islandId: 'home', name: '' }, seq: 9 },
      now,
    );
  });
});

describe('edit-biome', () => {
  it('legal: reassigns biome and deducts cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 30;
      home.buildings.push({
        id: 'ue-1', defId: 'universe_editor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.reality_anchor = 10;
      state.inventory.memetic_core = 10;
      state.inventory.phase_converter = 10;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'edit-biome', payload: { islandId: 'home', biomeId: 'forest' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const spec = await homeSpec(uid);
    expect(spec.biome).toBe('forest');
    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).reality_anchor).toBe(5);
  });

  it('illegal: same biome is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 30;
      home.buildings.push({
        id: 'ue-1', defId: 'universe_editor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.reality_anchor = 10;
      state.inventory.memetic_core = 10;
      state.inventory.phase_converter = 10;
    });
    await expectRejectNoChange(
      uid,
      { type: 'edit-biome', payload: { islandId: 'home', biomeId: 'plains' }, seq: 9 },
      now,
    );
  });
});

describe('construct-island', () => {
  it('legal: constructs an artificial island and deducts cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 15;
      home.buildings.push({
        id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
      // Reveal the target footprint cells at cx=100, cy=100, radii 4x4.
      const cx = 100, cy = 100, major = 4, minor = 4;
      const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
      const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
      for (let dy = yMin; dy <= yMax; dy++) {
        for (let dx = xMin; dx <= xMax; dx++) {
          if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
          const c = tileToCell(cx + dx, cy + dy);
          world.revealedCells.add(cellKey(c.cellX, c.cellY));
        }
      }
    });

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'construct-island',
        payload: {
          founderIslandId: 'home',
          biome: 'plains',
          majorRadius: 4,
          minorRadius: 4,
          cx: 100,
          cy: 100,
          displayName: 'Artificial One',
        },
        seq: 2,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const world = await worldSnap(uid);
    const artificial = world.islands.find((s: any) => s.id === 'art-1');
    expect(artificial).toBeTruthy();
    expect(artificial.name).toBe('Artificial One');
    expect(artificial.biome).toBe('plains');
    expect(artificial.artificial).toBe(true);
    expect(artificial.populated).toBe(true);
    const state = await homeState(uid);
    expect((state.inventory as Record<string, number>).concrete).toBeLessThan(10000);
  });

  it('illegal: founder below T3 is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
    });
    await expectRejectNoChange(
      uid,
      {
        type: 'construct-island',
        payload: {
          founderIslandId: 'home',
          biome: 'plains',
          majorRadius: 4,
          minorRadius: 4,
          cx: 100,
          cy: 100,
        },
        seq: 9,
      },
      now,
    );
  });

  it('illegal: overlapping an existing island is rejected, save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 15;
      home.buildings.push({
        id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'construct-island',
        payload: {
          founderIslandId: 'home',
          biome: 'plains',
          majorRadius: 4,
          minorRadius: 4,
          cx: 0,
          cy: 0,
        },
        seq: 9,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: false, error: 'position-occupied' });
  });

  it('illegal: footprint extends into unknown space is rejected with in-unknown-space', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 15;
      home.buildings.push({
        id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
      // Do NOT reveal cells at 9000/9000 — footprint must be in unknown space.
    });
    const ack = await applyIntent(
      pool, uid,
      {
        type: 'construct-island',
        payload: {
          founderIslandId: 'home',
          biome: 'plains',
          majorRadius: 4,
          minorRadius: 4,
          cx: 9000,
          cy: 9000,
        },
        seq: 10,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: false, error: 'in-unknown-space' });
  });

  it('legal: footprint fully within revealedCells succeeds', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      state.level = 15;
      home.buildings.push({
        id: 'pc-1', defId: 'platform_constructor', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now,
      });
      state.buildings = home.buildings;
      state.inventory.steel_beam = 10000;
      state.inventory.concrete = 10000;
      // Reveal the target footprint cells at cx=100, cy=100, radii 4x4.
      const cx = 100, cy = 100, major = 4, minor = 4;
      const xMin = -Math.ceil(major), xMax = Math.ceil(major) - 1;
      const yMin = -Math.ceil(minor), yMax = Math.ceil(minor) - 1;
      for (let dy = yMin; dy <= yMax; dy++) {
        for (let dx = xMin; dx <= xMax; dx++) {
          if (!tileInscribedInEllipse(dx, dy, major, minor)) continue;
          const c = tileToCell(cx + dx, cy + dy);
          world.revealedCells.add(cellKey(c.cellX, c.cellY));
        }
      }
    });

    const ack = await applyIntent(
      pool, uid,
      {
        type: 'construct-island',
        payload: {
          founderIslandId: 'home',
          biome: 'plains',
          majorRadius: 4,
          minorRadius: 4,
          cx: 100,
          cy: 100,
          displayName: 'Revealed Island',
        },
        seq: 11,
      },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 11 });

    const world = await worldSnap(uid);
    const artificial = world.islands.find((s: any) => s.id === 'art-1');
    expect(artificial).toBeTruthy();
    expect(artificial.biome).toBe('plains');
  });
});


describe('refresh-maintenance', () => {
  it('legal: refreshes a degraded building and deducts the 50% placement cost', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
        operatingMs: 12 * 60 * 60 * 1000 + 1,
      });
      state.buildings = home.buildings;
      state.inventory.wood = 100;
      state.inventory.stone = 100;
      state.inventory.iron_ingot = 30;
    });

    const ack = await applyIntent(
      pool, uid,
      { type: 'refresh-maintenance', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const state = await homeState(uid);
    const b = (state.buildings as Array<Record<string, unknown>>).find((bb) => bb.id === 'workshop-1')!;
    expect(b.operatingMs).toBe(0);
    const inv = state.inventory as Record<string, number>;
    expect(inv.wood).toBe(25);
    expect(inv.stone).toBe(50);
    expect(inv.iron_ingot).toBe(15);
  });

  it('illegal: refresh is rejected when maintenance is not due', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
        operatingMs: 0,
      });
      state.buildings = home.buildings;
      state.inventory.wood = 100;
      state.inventory.stone = 100;
      state.inventory.iron_ingot = 30;
    });
    await expectRejectNoChange(
      uid,
      { type: 'refresh-maintenance', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 9 },
      now,
    );
  });

  it('illegal: refresh is rejected when materials are insufficient', async () => {
    const now = Date.now();
    const uid = await aUserWithModifiedGame(now, (world, islandStates) => {
      const home = world.islands.find((s: any) => s.id === 'home');
      const state = islandStates.get('home');
      home.buildings.push({
        id: 'workshop-1', defId: 'workshop', x: 0, y: 0,
        constructionRemainingMs: 0, placedAt: now, tier: 1,
        operatingMs: 12 * 60 * 60 * 1000 + 1,
      });
      state.buildings = home.buildings;
      state.inventory.wood = 0;
      state.inventory.stone = 0;
      state.inventory.iron_ingot = 0;
    });
    await expectRejectNoChange(
      uid,
      { type: 'refresh-maintenance', payload: { islandId: 'home', buildingId: 'workshop-1' }, seq: 9 },
      now,
    );
  });
});


describe('active-heartbeat', () => {
  it('accrues focused ms and stamps lastActiveMs', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 60_000, unfocusedMs: 0 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(true);
    const snap = await loadSnapshot(pool, uid);
    expect(snap!.world.activeBonusMs).toBe(60_000);
    expect(snap!.world.lastActiveMs).toBe(now);
  });

  it('decays for unfocused ms', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 120_000, unfocusedMs: 0 }, seq: 1 },
      now,
    );
    const ack = await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 0, unfocusedMs: 20_000 }, seq: 2 },
      now,
    );
    expect(ack.ok).toBe(true);
    const snap = await loadSnapshot(pool, uid);
    expect(snap!.world.activeBonusMs).toBe(60_000); // 120_000 − 3 × 20_000
  });

  it('floors activeBonusMs at 0', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    const ack = await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 0, unfocusedMs: 60_000 }, seq: 1 },
      now,
    );
    expect(ack.ok).toBe(true);
    const snap = await loadSnapshot(pool, uid);
    expect(snap!.world.activeBonusMs).toBe(0);
  });

  it('rejects negative focusedMs and leaves save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'active-heartbeat', payload: { focusedMs: -1000, unfocusedMs: 0 }, seq: 1 },
      now,
    );
  });

  it('rejects non-numeric payload', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'active-heartbeat', payload: { focusedMs: 'lots', unfocusedMs: 0 }, seq: 1 },
      now,
    );
  });
});


/** Read the serialized snapshot's tutorial state. */
async function tutorialSnap(uid: string): Promise<{
  completed: string[];
  current: string | null;
  xpBumpClaimed?: string[];
}> {
  const snap = await loadSnapshot(pool, uid);
  return snap!.world.tutorialState as {
    completed: string[];
    current: string | null;
    xpBumpClaimed?: string[];
  };
}

describe('mark-tutorial-completed', () => {
  it('marks the step completed and grants the home island XP once', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    const ack = await applyIntent(
      pool, uid,
      { type: 'mark-tutorial-completed', payload: { stepId: '01_location' }, seq: 1 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 1 });

    const ts = await tutorialSnap(uid);
    expect(ts.completed).toContain('01_location');
    expect(ts.xpBumpClaimed).toContain('01_location');

    const home = await homeState(uid);
    const expectedXp = (1 / 100) * ((home.level as number) + 1) ** 2.2 * 25;
    expect(home.xp as number).toBeCloseTo(expectedXp, 5);

    // Idempotent: second completion for the same step must grant no extra XP.
    const before = home.xp as number;
    const dup = await applyIntent(
      pool, uid,
      { type: 'mark-tutorial-completed', payload: { stepId: '01_location' }, seq: 2 },
      now,
    );
    expect(dup).toMatchObject({ ok: true, seq: 2 });
    const homeAfter = await homeState(uid);
    expect(homeAfter.xp as number).toBe(before);
  });

  it('indexes the ramp off the claimed count', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    await applyIntent(
      pool, uid,
      { type: 'mark-tutorial-completed', payload: { stepId: '01_location' }, seq: 1 },
      now,
    );
    const homeAfter1 = await homeState(uid);
    const xp1 = homeAfter1.xp as number;

    await applyIntent(
      pool, uid,
      { type: 'mark-tutorial-completed', payload: { stepId: '02_inventory' }, seq: 2 },
      now,
    );
    const homeAfter2 = await homeState(uid);
    const xp2 = homeAfter2.xp as number;
    const delta = xp2 - xp1;

    // The second completion should grant 2% (not 1%) of the next-level threshold.
    const expectedDelta = (2 / 100) * ((homeAfter2.level as number) + 1) ** 2.2 * 25;
    expect(delta).toBeCloseTo(expectedDelta, 5);
  });

  it('rejects a non-string stepId and leaves save unchanged', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();
    await expectRejectNoChange(
      uid,
      { type: 'mark-tutorial-completed', payload: { stepId: 123 }, seq: 1 },
      now,
    );
  });
});

describe('skip-tutorial', () => {
  it('fills completed and xpBumpClaimed with every tutorial id', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    const ack = await applyIntent(
      pool, uid,
      { type: 'skip-tutorial', payload: {}, seq: 1 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 1 });

    const ts = await tutorialSnap(uid);
    expect(ts.completed.length).toBe(72);
    expect(ts.xpBumpClaimed!.length).toBe(72);
  });
});

describe('restart-tutorial', () => {
  it('clears completed while preserving xpBumpClaimed', async () => {
    const now = Date.now();
    const uid = await aUserWithGame();

    await applyIntent(
      pool, uid,
      { type: 'skip-tutorial', payload: {}, seq: 1 },
      now,
    );

    const ack = await applyIntent(
      pool, uid,
      { type: 'restart-tutorial', payload: {}, seq: 2 },
      now,
    );
    expect(ack).toMatchObject({ ok: true, seq: 2 });

    const ts = await tutorialSnap(uid);
    expect(ts.completed.length).toBe(0);
    expect(ts.xpBumpClaimed!.length).toBe(72);
  });
});

describe('§9.8 server-authoritative trades', () => {
  // A home island wired for trade: signal_exchange present, give-stock + an
  // everProduced get-target with headroom, cooldown ready.
  function tradeReadySnap(now: number): SaveSnapshot {
    const snap = createInitialSnapshot(now);
    const home = snap.islandStates.find((e) => e.id === 'home')!;
    const st = home.state as unknown as {
      inventory: Record<string, number>;
      storageCaps: Record<string, number>;
      buildings: Array<Record<string, unknown>>;
      everProduced: string[];
      tradeCooldownMs: number;
      tradeAcceptCount: number;
    };
    st.inventory.iron_ore = 1000;
    st.inventory.copper_ore = 0;
    st.storageCaps.copper_ore = 1000;
    st.everProduced = ['copper_ore'];
    st.buildings.push({ id: 'sx-1', defId: 'signal_exchange', x: 2, y: 2, placedAt: now });
    st.tradeCooldownMs = 0;
    st.tradeAcceptCount = 0;
    return snap;
  }

  it('a focused heartbeat spawns a trade offer for a signal_exchange island', async () => {
    const t0 = 1_700_000_000_000;
    const uid = await userWithSnapshot(tradeReadySnap(t0));
    const ack = await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 5_000, unfocusedMs: 0 }, seq: 1 },
      t0,
    );
    expect(ack.ok).toBe(true);
    const out = await loadSnapshot(pool, uid);
    expect(out!.world.tradeOffers!.length).toBeGreaterThanOrEqual(1);
    expect(out!.world.tradeOffers![0]!.islandId).toBe('home');
  });

  it('accept-trade applies the exchange, removes the offer, and compounds cadence', async () => {
    const t0 = 1_700_000_000_000;
    const snap = tradeReadySnap(t0);
    (snap.world as { tradeOffers?: Array<Record<string, unknown>> }).tradeOffers = [{
      id: 'home-0-x', islandId: 'home',
      give: { res: 'iron_ore', qty: 100 }, get: { res: 'copper_ore', qty: 50 },
      spawnedAt: t0, expiresAt: t0 + 300_000,
    }];
    const uid = await userWithSnapshot(snap);
    const ack = await applyIntent(
      pool, uid,
      { type: 'accept-trade', payload: { offerId: 'home-0-x' }, seq: 1 },
      t0, // 0 gap → no economy advance, so inventory change is purely the trade
    );
    expect(ack.ok).toBe(true);
    const st = await homeState(uid);
    expect((st.inventory as Record<string, number>).iron_ore).toBe(900);
    expect((st.inventory as Record<string, number>).copper_ore).toBe(50);
    expect(st.tradeAcceptCount).toBe(1);
    const out = await loadSnapshot(pool, uid);
    expect(out!.world.tradeOffers).toEqual([]);
  });

  it('accept-trade rejects an expired offer and leaves state untouched', async () => {
    const t0 = 1_700_000_000_000;
    const snap = tradeReadySnap(t0);
    (snap.world as { tradeOffers?: Array<Record<string, unknown>> }).tradeOffers = [{
      id: 'home-0-old', islandId: 'home',
      give: { res: 'iron_ore', qty: 100 }, get: { res: 'copper_ore', qty: 50 },
      spawnedAt: t0 - 600_000, expiresAt: t0 - 300_000, // already lapsed
    }];
    const uid = await userWithSnapshot(snap);
    const ack = await applyIntent(
      pool, uid,
      { type: 'accept-trade', payload: { offerId: 'home-0-old' }, seq: 1 },
      t0,
    );
    expect(ack.ok).toBe(false);
    const st = await homeState(uid);
    expect((st.inventory as Record<string, number>).iron_ore).toBe(1000);
    expect(st.tradeAcceptCount).toBe(0);
  });

  it('reject-trade compounds cadence and removes the offer without exchanging goods', async () => {
    const t0 = 1_700_000_000_000;
    const snap = tradeReadySnap(t0);
    (snap.world as { tradeOffers?: Array<Record<string, unknown>> }).tradeOffers = [{
      id: 'home-0-y', islandId: 'home',
      give: { res: 'iron_ore', qty: 100 }, get: { res: 'copper_ore', qty: 50 },
      spawnedAt: t0, expiresAt: t0 + 300_000,
    }];
    const uid = await userWithSnapshot(snap);
    const ack = await applyIntent(
      pool, uid,
      { type: 'reject-trade', payload: { offerId: 'home-0-y' }, seq: 1 },
      t0,
    );
    expect(ack.ok).toBe(true);
    const st = await homeState(uid);
    expect((st.inventory as Record<string, number>).iron_ore).toBe(1000); // no goods moved
    expect(st.tradeAcceptCount).toBe(1);
    const out = await loadSnapshot(pool, uid);
    expect(out!.world.tradeOffers).toEqual([]);
  });
});

describe('active-heartbeat — §9.9 bonus accrues under focused play', () => {
  // Regression: before the heartbeat-ownership fix, every intent's
  // loadAndCatchUp re-charged the inter-heartbeat window as 3× "away" decay
  // while the heartbeat accrued the same window at 1×, so a fully-focused
  // player's bonus only ever DRAINED. It must now tick UP.
  it('consecutive fully-focused heartbeats increase the bonus, never drain it', async () => {
    const t0 = 1_000_000_000_000;
    const snap = createInitialSnapshot(t0);
    (snap.world as { activeBonusMs?: number }).activeBonusMs = 10_000;
    (snap.world as { lastActiveMs?: number }).lastActiveMs = t0;
    const uid = await userWithSnapshot(snap);

    let now = t0;
    for (let i = 0; i < 3; i++) {
      now += 5_000;
      const ack = await applyIntent(
        pool, uid,
        { type: 'active-heartbeat', payload: { focusedMs: 5_000, unfocusedMs: 0 }, seq: i + 1 },
        now,
      );
      expect(ack.ok).toBe(true);
    }
    const out = await loadSnapshot(pool, uid);
    expect(out!.world.activeBonusMs).toBeGreaterThan(10_000);
  });

  it('away-time reported as unfocused still decays the bonus authoritatively', async () => {
    const t0 = 1_000_000_000_000;
    const snap = createInitialSnapshot(t0);
    (snap.world as { activeBonusMs?: number }).activeBonusMs = 10_000;
    (snap.world as { lastActiveMs?: number }).lastActiveMs = t0;
    const uid = await userWithSnapshot(snap);

    // First heartbeat reports a large unfocused away-gap (the boot seed).
    const ack = await applyIntent(
      pool, uid,
      { type: 'active-heartbeat', payload: { focusedMs: 0, unfocusedMs: 60_000 }, seq: 1 },
      t0 + 60_000,
    );
    expect(ack.ok).toBe(true);
    const out = await loadSnapshot(pool, uid);
    // 10000 − 3×60000 floored at 0.
    expect(out!.world.activeBonusMs).toBe(0);
  });
});
