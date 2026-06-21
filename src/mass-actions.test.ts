import { describe, it, expect } from 'vitest';
import {
  buildingFootprintTilesWorld, buildingsInBox, planMassUpgrade,
  validateGroupRelocate, groupRelocateFee, ignoreCapUnion, selectionBreakdown,
} from './mass-actions.js';
import { makeInitialIslandState, attachTerrainAt } from './world.js';
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
    const tiles = buildingFootprintTilesWorld(spec([]), b('a', 'iron_mine', 3, -4));
    expect(tiles).toContainEqual({ x: 103, y: 196 });
  });
});

describe('buildingsInBox', () => {
  it('includes a building whose tile falls inside the box, excludes others', () => {
    const s = spec([b('a', 'iron_mine', 0, 0), b('b', 'iron_mine', 20, 20)]);
    const hit = buildingsInBox(s, { x0: 99, y0: 199, x1: 105, y1: 205 });
    expect(hit).toEqual(['a']);
  });
  it('normalizes a box dragged up-left', () => {
    const s = spec([b('a', 'iron_mine', 0, 0)]);
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
  return { id, defId: 'iron_mine', x: 0, y: 0, floorLevel } as unknown as PlacedBuilding;
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

// ---------------------------------------------------------------------------
// validateGroupRelocate / groupRelocateFee / ignoreCapUnion / selectionBreakdown
// ---------------------------------------------------------------------------

// `cell_press` is tier 1 (unlocked at level 1), a single-tile land def with NO
// requiredTile — placeable anywhere inside the island ellipse on `plains`. Using
// a real island (attachTerrainAt) so off-island / overlap rejection is genuine.
function relocSpec(buildings: PlacedBuilding[]): IslandSpec {
  return attachTerrainAt({
    id: 'reloc', name: 'reloc', cx: 0, cy: 0,
    majorRadius: 14, minorRadius: 14, biome: 'plains',
    populated: true, discovered: true,
    buildings, modifiers: [],
  } as unknown as Omit<IslandSpec, 'terrainAt'>);
}
function cp(id: string, x: number, y: number): PlacedBuilding {
  return { id, defId: 'cell_press', x, y, floorLevel: 0 } as unknown as PlacedBuilding;
}

describe('validateGroupRelocate', () => {
  it('accepts a clean rigid translation into free tiles', () => {
    const members = [cp('a', 0, 0), cp('b', 1, 0)];
    const spec = relocSpec([...members]);
    const state = makeInitialIslandState(spec, 0);
    expect(validateGroupRelocate(spec, state, members, 2, 0)).toEqual({ ok: true });
  });

  it('accepts a translation into a tile a sibling is vacating', () => {
    // a:(0,0) -> (1,0), b:(1,0) -> (2,0). a moves into b's OLD tile. Must pass
    // because the world is evaluated POST-move (the sibling-overlap caveat).
    const members = [cp('a', 0, 0), cp('b', 1, 0)];
    const spec = relocSpec([...members]);
    const state = makeInitialIslandState(spec, 0);
    expect(validateGroupRelocate(spec, state, members, 1, 0)).toEqual({ ok: true });
  });

  it('rejects a translation that pushes a member off the island', () => {
    const members = [cp('a', 0, 0)];
    const spec = relocSpec([...members]);
    const state = makeInitialIslandState(spec, 0);
    const r = validateGroupRelocate(spec, state, members, 1000, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('out-of-bounds');
  });

  it('rejects when two moved members land on the same tile', () => {
    // A uniform translation can't make two distinct tiles coincide, so to
    // exercise the member-vs-member overlap branch we pass two members that
    // start on the SAME tile (a duplicate selection) — post-move they collide.
    const m = cp('a', 0, 0);
    const spec = relocSpec([m]);
    const state = makeInitialIslandState(spec, 0);
    const r = validateGroupRelocate(spec, state, [m, cp('b', 0, 0)], 1, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('member-overlap');
  });

  it('rejects overlap with a NON-selected building at its fixed position', () => {
    // selected a:(0,0); a stationary cell_press 'x' sits at (1,0). Translating a
    // by (1,0) lands on x's tile — x is not a member, so validatePlacement
    // overlap fires.
    const a = cp('a', 0, 0);
    const x = cp('x', 1, 0);
    const spec = relocSpec([a, x]);
    const state = makeInitialIslandState(spec, 0);
    const r = validateGroupRelocate(spec, state, [a], 1, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('overlap');
  });
});

describe('groupRelocateFee', () => {
  it('sums relocateFee across members', () => {
    // cell_press placementCost wire/iron_ingot/etc. floorLevel 0 -> invested =
    // base placementCost; relocateFee = floor(half) per resource. Two members
    // => 2x the single-member fee.
    const members = [cp('a', 0, 0), cp('b', 1, 0)];
    const fee = groupRelocateFee(members);
    const single = groupRelocateFee([cp('a', 0, 0)]);
    for (const [r, n] of Object.entries(single)) {
      expect(fee[r as keyof typeof fee]).toBe((n as number) * 2);
    }
    expect(Object.keys(fee).length).toBeGreaterThan(0);
  });
});

describe('ignoreCapUnion', () => {
  it('unions output resources and derives allSet per resource', () => {
    const spec = relocSpec([]);
    // two cell_press (output saltwater_cell) + one workshop (output bolt).
    const a = { id: 'a', defId: 'cell_press', x: 0, y: 0, floorLevel: 0,
      ignoreCapOverrides: { saltwater_cell: true } } as unknown as PlacedBuilding;
    const b = { id: 'b', defId: 'cell_press', x: 1, y: 0, floorLevel: 0,
      ignoreCapOverrides: { saltwater_cell: false } } as unknown as PlacedBuilding;
    const w = { id: 'w', defId: 'workshop', x: 2, y: 0, floorLevel: 0,
      ignoreCapOverrides: { bolt: true } } as unknown as PlacedBuilding;
    const rows = ignoreCapUnion([
      { spec, building: a }, { spec, building: b }, { spec, building: w },
    ]);
    const byRes = Object.fromEntries(rows.map((r) => [r.resource, r.allSet]));
    // saltwater_cell: a=true, b=false -> not all set.
    expect(byRes.saltwater_cell).toBe(false);
    // bolt: only producer w has it true -> all set.
    expect(byRes.bolt).toBe(true);
    expect(rows.length).toBe(2);
  });

  it('treats a missing override as not-set for allSet', () => {
    const spec = relocSpec([]);
    const a = { id: 'a', defId: 'workshop', x: 0, y: 0, floorLevel: 0,
      ignoreCapOverrides: { bolt: true } } as unknown as PlacedBuilding;
    const b = { id: 'b', defId: 'workshop', x: 1, y: 0, floorLevel: 0 } as unknown as PlacedBuilding;
    const rows = ignoreCapUnion([{ spec, building: a }, { spec, building: b }]);
    expect(rows).toEqual([{ resource: 'bolt', allSet: false }]);
  });
});

describe('selectionBreakdown', () => {
  it('counts per defId descending by count', () => {
    const out = selectionBreakdown([
      cp('a', 0, 0),
      { id: 'm', defId: 'iron_mine', x: 0, y: 0, floorLevel: 0 } as unknown as PlacedBuilding,
      cp('b', 1, 0),
      cp('c', 2, 0),
    ]);
    expect(out).toEqual([
      { defId: 'cell_press', count: 3 },
      { defId: 'iron_mine', count: 1 },
    ]);
  });
});
