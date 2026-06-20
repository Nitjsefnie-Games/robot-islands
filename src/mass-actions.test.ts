import { describe, it, expect } from 'vitest';
import { buildingFootprintTilesWorld, buildingsInBox, planMassUpgrade } from './mass-actions.js';
import { makeInitialIslandState } from './world.js';
import type { IslandSpec } from './world.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';

function spec(buildings: PlacedBuilding[]): IslandSpec {
  return { id: 'i1', cx: 100, cy: 200, buildings } as unknown as IslandSpec;
}
function b(id: string, defId: string, x: number, y: number): PlacedBuilding {
  return { id, defId, x, y, floorLevel: 0 } as unknown as PlacedBuilding;
}

describe('buildingFootprintTilesWorld', () => {
  it('offsets a land 1x1 footprint by the island centre', () => {
    const tiles = buildingFootprintTilesWorld(spec([]), b('a', 'mine', 3, -4));
    expect(tiles).toContainEqual({ x: 103, y: 196 });
  });
});

describe('buildingsInBox', () => {
  it('includes a building whose tile falls inside the box, excludes others', () => {
    const s = spec([b('a', 'mine', 0, 0), b('b', 'mine', 20, 20)]);
    const hit = buildingsInBox(s, { x0: 99, y0: 199, x1: 105, y1: 205 });
    expect(hit).toEqual(['a']);
  });
  it('normalizes a box dragged up-left', () => {
    const s = spec([b('a', 'mine', 0, 0)]);
    expect(buildingsInBox(s, { x0: 105, y0: 205, x1: 99, y1: 199 })).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// planMassUpgrade
// ---------------------------------------------------------------------------

// Build a real IslandState (so the slot helpers, which read unlockedNodes /
// skill multipliers, don't crash on a bare stub). `mine` has placementCost
// { stone: 200, wood: 80 }; each floor upgrade (target ≤ 10, factor 0.8) costs
// ceil(200*0.8)=160 stone + ceil(80*0.8)=64 wood, independent of floor.
function mine(id: string, floorLevel: number): PlacedBuilding {
  return { id, defId: 'mine', x: 0, y: 0, floorLevel } as unknown as PlacedBuilding;
}

function upgState(buildings: PlacedBuilding[], stone: number, wood: number): IslandState {
  const s = makeInitialIslandState(
    { id: 'i', name: 'i', biome: 'plains', cx: 0, cy: 0, majorRadius: 14, minorRadius: 14, populated: true, discovered: true, buildings: [], modifiers: [] } as unknown as IslandSpec,
    0,
  );
  s.buildings = buildings;
  s.inventory.stone = stone;
  s.inventory.wood = wood;
  return s;
}

describe('planMassUpgrade', () => {
  it('picks lowest-floor first, skips unaffordable, caps at affordability', () => {
    // 3 mines floors [2,0,1]; inventory affords exactly 2 upgrades (320 stone,
    // 128 wood). Free slots default 1 build + 2 queue = 3, so affordability is
    // the binding limit. Sorted lowest-floor-first: m1(0), m2(1), m0(2).
    const state = upgState([mine('m0', 2), mine('m1', 0), mine('m2', 1)], 320, 128);
    const plan = planMassUpgrade(state, ['m0', 'm1', 'm2']);
    expect(plan[0]).toBe('m1'); // floor 0 (lowest)
    expect(plan).toEqual(['m1', 'm2']);
  });

  it('caps the plan at the number of free build+queue slots', () => {
    // Plentiful inventory but only 3 free slots (1 build + 2 queue, no skills).
    const state = upgState(
      [mine('m0', 0), mine('m1', 0), mine('m2', 0), mine('m3', 0), mine('m4', 0)],
      1_000_000,
      1_000_000,
    );
    const plan = planMassUpgrade(state, ['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(plan).toHaveLength(3);
  });

  it('skips buildings that are still under construction or queued', () => {
    const state = upgState([mine('m0', 0)], 1_000_000, 1_000_000);
    state.buildings[0]!.constructionRemainingMs = 5000;
    expect(planMassUpgrade(state, ['m0'])).toEqual([]);
  });

  it('returns [] when no free slots', () => {
    // Saturate the 3 free slots with in-progress + queued upgrade jobs.
    const state = upgState([mine('m0', 0), mine('m1', 0)], 1_000_000, 1_000_000);
    state.buildings[1]!.constructionRemainingMs = 5000; // 1 in-progress build (uses the 1 build slot)
    state.buildJobs = [
      { buildingId: 'm0', targetLevel: 1 },
      { buildingId: 'm0', targetLevel: 2 },
    ] as unknown as IslandState['buildJobs']; // 2 queued (uses both queue slots)
    expect(planMassUpgrade(state, ['m0'])).toEqual([]);
  });
});
