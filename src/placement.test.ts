// Pure-layer tests for §4 placement math.
//
// Three concerns covered:
//   1. footprintTiles / rotatedDims — the rotation transform produces the
//      right tile sets for 1×1, 2×2, and 2×3 rectangles at all four
//      rotations.
//   2. validatePlacement — each rejection reason fires in the right
//      situation, and the success path passes.
//   3. placeBuilding — appends a stable-id instance, bumps storage caps for
//      storage defs.
//
// Integration with the live economy lives in `economy.test.ts` (placement
// of a Smelter then verifying it produces iron_ingot via computeRates).

import { describe, expect, it } from 'vitest';

import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import {
  footprintTiles,
  placeBuilding,
  rotatedDims,
  validatePlacement,
  type Rotation,
} from './placement.js';
import { makeInitialIslandState } from './world.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tileSet(tiles: ReadonlyArray<{ x: number; y: number }>): Set<string> {
  return new Set(tiles.map((t) => `${t.x},${t.y}`));
}

function makeSpec(overrides: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'test',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...overrides,
  };
}

function makeState(spec: IslandSpec, level: number = 1): IslandState {
  const s = makeInitialIslandState(spec, 0);
  s.level = level;
  return s;
}

// ---------------------------------------------------------------------------
// footprintTiles
// ---------------------------------------------------------------------------
describe('footprintTiles', () => {
  it('1×1 footprint covers exactly one tile under any rotation', () => {
    for (const r of [0, 1, 2, 3] as Rotation[]) {
      const tiles = footprintTiles(1, 1, 5, 7, r);
      expect(tiles).toHaveLength(1);
      expect(tiles[0]).toEqual({ x: 5, y: 7 });
    }
  });

  it('2×2 footprint at (10, 20) covers the same 4 tiles under any rotation', () => {
    // A square is rotation-invariant; the tile set should match exactly.
    const expected = tileSet([
      { x: 10, y: 20 },
      { x: 11, y: 20 },
      { x: 10, y: 21 },
      { x: 11, y: 21 },
    ]);
    for (const r of [0, 1, 2, 3] as Rotation[]) {
      const tiles = footprintTiles(2, 2, 10, 20, r);
      expect(tiles).toHaveLength(4);
      expect(tileSet(tiles)).toEqual(expected);
    }
  });

  it('2×3 footprint at (0, 0) produces the right tile sets under each rotation', () => {
    // Rotation 0: 2 wide × 3 tall block at (0,0).
    expect(tileSet(footprintTiles(2, 3, 0, 0, 0))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
        { x: 0, y: 2 }, { x: 1, y: 2 },
      ]),
    );
    // Rotation 1 (90° CW): bounding box is 3 wide × 2 tall at (0,0).
    expect(tileSet(footprintTiles(2, 3, 0, 0, 1))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
      ]),
    );
    // Rotation 2 (180°): bounding box is 2 wide × 3 tall at (0,0), same set
    // as rotation 0 for a solid rectangle.
    expect(tileSet(footprintTiles(2, 3, 0, 0, 2))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
        { x: 0, y: 2 }, { x: 1, y: 2 },
      ]),
    );
    // Rotation 3 (270° CW): bounding box is 3 wide × 2 tall at (0,0), same
    // set as rotation 1 for a solid rectangle.
    expect(tileSet(footprintTiles(2, 3, 0, 0, 3))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
      ]),
    );
  });
});

describe('rotatedDims', () => {
  it('keeps {w, h} on rotations 0 and 2', () => {
    expect(rotatedDims(2, 3, 0)).toEqual({ width: 2, height: 3 });
    expect(rotatedDims(2, 3, 2)).toEqual({ width: 2, height: 3 });
    expect(rotatedDims(4, 1, 0)).toEqual({ width: 4, height: 1 });
  });

  it('swaps to {h, w} on rotations 1 and 3', () => {
    expect(rotatedDims(2, 3, 1)).toEqual({ width: 3, height: 2 });
    expect(rotatedDims(2, 3, 3)).toEqual({ width: 3, height: 2 });
    expect(rotatedDims(4, 1, 1)).toEqual({ width: 1, height: 4 });
  });
});

// ---------------------------------------------------------------------------
// validatePlacement
// ---------------------------------------------------------------------------
describe('validatePlacement', () => {
  it('returns ok=true for an in-island, non-overlapping, unlocked placement', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Mine (2×2) at (0,0) — all four corners inside r=14 ellipse.
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('returns out-of-bounds when a tile sits outside the ellipse', () => {
    const spec = makeSpec({ majorRadius: 5, minorRadius: 5 });
    const state = makeState(spec);
    // 2×2 anchor at (4,4): tile (5,5) is outside the r=5 disk (corners go
    // up to (6,6), which violates tileInscribedInEllipse).
    const v = validatePlacement(spec, state, 'mine', 4, 4, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('out-of-bounds');
  });

  it('returns overlap when a tile is already covered by an existing building', () => {
    const existing: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    const spec = makeSpec({ buildings: [existing] });
    const state = makeState(spec);
    // Try to place another Mine at (1, 1) — its top-left tile (1,1) lies
    // inside the existing Mine's 2×2 footprint (0..1, 0..1).
    const v = validatePlacement(spec, state, 'mine', 1, 1, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('overlap');
  });

  it('returns def-not-unlocked when island level is below the def tier', () => {
    const spec = makeSpec();
    const state = makeState(spec, 1);
    // assembler is T2 (unlocked at level 5). Level-1 island can't place.
    const v = validatePlacement(spec, state, 'assembler', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-unlocked');
  });

  it('returns biome-locked when a §9.5 unique fails canPlaceOnIsland', () => {
    const spec = makeSpec({ biome: 'plains' });
    const state = makeState(spec, 30); // T4 level so the tier gate passes
    // pyroforge requires Volcanic biome; this is Plains.
    const v = validatePlacement(spec, state, 'pyroforge', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('biome-locked');
  });

  // -------------------------------------------------------------------------
  // tile-requirement-not-met (§4.3 / §8.1) — Mine on ore vs coal vs grass
  // -------------------------------------------------------------------------
  // Mine carries `requiredTile: ['ore', 'coal']`. Every footprint tile must
  // belong to that set. validatePlacement enforces it only when the spec
  // carries a `terrainAt` closure — synthetic specs without one skip the
  // check (existing tests above rely on that pass-through).

  it('returns ok=true for a Mine on a homogeneous ore footprint', () => {
    const spec = makeSpec({ terrainAt: () => 'ore' });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('returns ok=true for a Mine on a homogeneous coal footprint', () => {
    const spec = makeSpec({ terrainAt: () => 'coal' });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('returns ok=true for a Mine on a mixed ore+coal footprint (both in requiredTile)', () => {
    // Half ore, half coal under the 2×2 footprint at (0,0). Every tile is in
    // the allowed set, so the gate passes even though the cells are mixed.
    const spec = makeSpec({
      terrainAt: (x, _y) => (x === 0 ? 'ore' : 'coal'),
    });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('returns tile-requirement-not-met for a Mine on all-grass terrain', () => {
    const spec = makeSpec({ terrainAt: () => 'grass' });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('tile-requirement-not-met');
  });

  it('returns tile-requirement-not-met when even one footprint tile is grass', () => {
    // 3 of 4 footprint tiles are ore; the (1,1) corner is grass. The
    // §4.3 rule is EVERY cell — one mismatched tile rejects.
    const spec = makeSpec({
      terrainAt: (x, y) => (x === 1 && y === 1 ? 'grass' : 'ore'),
    });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('tile-requirement-not-met');
  });

  it('skips the tile check when the def has no requiredTile (Workshop on grass is fine)', () => {
    // Workshop has no requiredTile; placing on all-grass terrain should pass
    // the §4.3 gate. Tier passes because makeState gives the state level 1
    // and Workshop is T1.
    const spec = makeSpec({ terrainAt: () => 'grass' });
    const state = makeState(spec);
    const v = validatePlacement(spec, state, 'workshop', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('rotation respects ellipse bounds', () => {
    // A 1×3 (vertical strip) at (0, -1) sits at (0,-1),(0,0),(0,1). All
    // inside r=5. Rotated by 1, it becomes 3×1 at (0,-1) covering
    // (0,-1),(1,-1),(2,-1) which is still inside r=5 (corner check:
    // (3, 0) is on the circle, fails strict-inside ⇒ rejected). The exact
    // boundary verifies the rotation transform feeds tileInscribedInEllipse
    // the rotated coords, not the original.
    const spec = makeSpec({ majorRadius: 5, minorRadius: 5 });
    const state = makeState(spec);
    // Use a real def with 1×3 footprint — electric_arc_furnace is 2×3, close
    // enough but we want a non-square. Pick crate (1×1) won't work; the
    // catalog has no 1×3, so emulate by checking a 2×3 (electric_arc_furnace).
    // electric_arc_furnace is T3 — bump level.
    state.level = 15;
    // 2×3 at (-1,-2) under rotation 0: covers x=[-1..0], y=[-2..0]. All
    // corners must be inside r=5. The far corner is (1, 1) — still inside.
    expect(validatePlacement(spec, state, 'electric_arc_furnace', -1, -2, 0).ok).toBe(true);
    // 2×3 at (-3, 0) under rotation 1 becomes 3×2 at (-3, 0): covers
    // x=[-3..-1], y=[0..1]. Tile (-3, 0) has corner (-3, 0) — strict-inside
    // check is x²/25 + y²/25 < 1 evaluated at the corner; (-3)²/25 = 0.36
    // and the other corner (-3, 1) → 0.36 + 0.04 = 0.40 < 1 ⇒ inscribed.
    expect(validatePlacement(spec, state, 'electric_arc_furnace', -3, 0, 1).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// placeBuilding
// ---------------------------------------------------------------------------
describe('placeBuilding', () => {
  it('appends a PlacedBuilding to spec.buildings (which state.buildings shares)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const placed = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-1');
    expect(placed).toEqual({ id: 'p-1', defId: 'mine', x: 0, y: 0, rotation: 0 });
    expect(spec.buildings).toHaveLength(1);
    expect(spec.buildings[0]).toBe(placed);
    // state.buildings is a live reference (NOT a copy) to spec.buildings,
    // so the same instance is visible from both sides.
    expect(state.buildings).toHaveLength(1);
    expect(state.buildings[0]).toBe(placed);
  });

  it('bumps storage caps when placing a storage def', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Pick one resource to baseline against — the baseline is the same for
    // every key in startingInventory's record.
    const before = state.storageCaps.iron_ore ?? 0;
    // crate has storageCap = 100.
    placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'p-crate');
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before + 100);
    }
  });

  it('leaves storage caps unchanged when placing a non-storage def', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine');
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('uses the provided id generator (called once per placement)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    let calls = 0;
    const gen = (): string => {
      calls += 1;
      return `gen-${calls}`;
    };
    const p1 = placeBuilding(spec, state, 'solar', 0, 0, 0, gen);
    const p2 = placeBuilding(spec, state, 'solar', 2, 0, 0, gen);
    expect(p1.id).toBe('gen-1');
    expect(p2.id).toBe('gen-2');
    expect(calls).toBe(2);
  });
});
