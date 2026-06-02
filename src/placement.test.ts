// Pure-layer tests for §4 placement math: footprintTiles/rotatedDims rotation
// transform, validatePlacement rejection reasons, placeBuilding instance
// append + storage-cap bumps. Live-economy integration lives in economy.test.ts.

import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import { SHAPES } from './shape-mask.js';
import type { PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY } from './storage-categories.js';
import {
  applyUpgrade,
  buildingAtTile,
  demolishBuilding,
  findOceanBuildingAt,
  formatShortfall,
  inProgressBuildCount,
  placeBuilding,
  placementCostFor,
  queuedBuildCount,
  queuedBuildSlots,
  relocateBuilding,
  sortByFillDesc,
  totalInvestedCost,
  upgradeCost,
  validatePlacement,
} from './placement.js';
import {
  footprintTiles,
  rotateShape,
  rotatedDims,
  type Rotation,
} from './shape-mask.js';
import { makeInitialIslandState, attachTerrainAt } from './world.js';
import type { IslandSpec } from './world.js';
import type { IslandState } from './economy.js';
import type { TerrainKind } from './island.js';
import { conversionCostForTarget } from './terrain-modifier.js';
import type { Graph } from './skilltree-graph.js';
import { DEFAULT_GRAPH } from './skilltree.js';
import { upgradeConstructionMs, BASE_CONSTRUCTION_MS_BY_TIER } from './construction.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tileSet(tiles: ReadonlyArray<{ x: number; y: number }>): Set<string> {
  return new Set(tiles.map((t) => `${t.x},${t.y}`));
}

function makeSpec(overrides: Partial<IslandSpec> = {}): IslandSpec {
  return {
    id: 'test',
    name: 'test',
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
  // §14 placement costs: seed plentiful inventory of every cost-basket
  // resource so tests focused on geometry/rotation/overlap/storage don't
  // also have to manage starter-bundle math. Each cost-targeted test
  // that needs to assert a SHORTAGE explicitly zeroes the relevant
  // resources before placing.
  s.inventory.stone = 10000;
  s.inventory.wood = 10000;
  s.inventory.iron_ingot = 10000;
  s.inventory.steel = 10000;
  s.inventory.steel_beam = 50000;
  s.inventory.concrete = 50000;
  s.inventory.clay = 50000;
  s.inventory.pipe = 10000;
  s.inventory.wire = 10000;
  s.inventory.gear = 10000;
  s.inventory.microchip = 10000;
  s.inventory.glass = 10000;
  s.inventory.silicon = 10000;
  s.inventory.aluminum = 10000;
  s.inventory.plastic_precursor = 10000;
  s.inventory.saltwater_cell = 10000;
  s.inventory.lead_ingot = 10000;
  s.inventory.ceramic_insulator = 10000;
  s.inventory.copper_ingot = 10000;
  s.inventory.magnet = 10000;
  s.inventory.stainless_steel = 10000;
  s.inventory.cryo_coolant = 10000;
  s.inventory.exotic_alloy = 10000;
  s.inventory.carbon_fiber = 10000;
  s.inventory.reality_anchor = 10000;
  s.inventory.antimatter_propellant = 10000;
  return s;
}

// ---------------------------------------------------------------------------
// footprintTiles
// ---------------------------------------------------------------------------
describe('footprintTiles', () => {
  it('1×1 footprint covers exactly one tile under any rotation', () => {
    for (const r of [0, 1, 2, 3] as Rotation[]) {
      const tiles = footprintTiles(SHAPES.single, 5, 7, r);
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
      const tiles = footprintTiles(SHAPES.square2, 10, 20, r);
      expect(tiles).toHaveLength(4);
      expect(tileSet(tiles)).toEqual(expected);
    }
  });

  it('2×3 footprint at (0, 0) produces the right tile sets under each rotation', () => {
    // Rotation 0: 2 wide × 3 tall block at (0,0).
    expect(tileSet(footprintTiles(SHAPES.rect2x3, 0, 0, 0))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
        { x: 0, y: 2 }, { x: 1, y: 2 },
      ]),
    );
    // Rotation 1 (90° CW): bounding box is 3 wide × 2 tall at (0,0).
    expect(tileSet(footprintTiles(SHAPES.rect2x3, 0, 0, 1))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
      ]),
    );
    // Rotation 2 (180°): bounding box is 2 wide × 3 tall at (0,0), same set
    // as rotation 0 for a solid rectangle.
    expect(tileSet(footprintTiles(SHAPES.rect2x3, 0, 0, 2))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 },
        { x: 0, y: 2 }, { x: 1, y: 2 },
      ]),
    );
    // Rotation 3 (270° CW): bounding box is 3 wide × 2 tall at (0,0), same
    // set as rotation 1 for a solid rectangle.
    expect(tileSet(footprintTiles(SHAPES.rect2x3, 0, 0, 3))).toEqual(
      tileSet([
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 },
        { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 },
      ]),
    );
  });
});

describe('rotatedDims', () => {
  it('keeps {w, h} on rotations 0 and 2', () => {
    expect(rotatedDims(SHAPES.rect2x3, 0)).toEqual({ width: 2, height: 3 });
    expect(rotatedDims(SHAPES.rect2x3, 2)).toEqual({ width: 2, height: 3 });
    expect(rotatedDims(SHAPES.line4h, 0)).toEqual({ width: 4, height: 1 });
  });

  it('swaps to {h, w} on rotations 1 and 3', () => {
    expect(rotatedDims(SHAPES.rect2x3, 1)).toEqual({ width: 3, height: 2 });
    expect(rotatedDims(SHAPES.rect2x3, 3)).toEqual({ width: 3, height: 2 });
    expect(rotatedDims(SHAPES.line4h, 1)).toEqual({ width: 1, height: 4 });
  });
});

describe('rotateShape', () => {
  it('rotates L-tromino 90°', () => {
    const r = rotateShape(SHAPES.lTromino, 1);
    expect(r.tiles).toContainEqual({ dx: 0, dy: 0 });
    expect(r.tiles).toContainEqual({ dx: 0, dy: 1 });
    expect(r.tiles).toContainEqual({ dx: -1, dy: 0 });
  });
  it('4 rotations returns original', () => {
    const r = rotateShape(SHAPES.lTetromino, 4);
    expect(r.tiles).toEqual(SHAPES.lTetromino.tiles);
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
    // Verifies the rotation transform feeds tileInscribedInEllipse the rotated
    // coords, not the original — exercised at the exact ellipse boundary.
    const spec = makeSpec({ majorRadius: 5, minorRadius: 5 });
    const state = makeState(spec);
    // electric_arc_furnace (2×3, non-square) is T3 — bump level past the gate.
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

  describe('validatePlacement — ignoreBuildingId + skipCostGate', () => {
    it('ignoreBuildingId excludes that building from the overlap check', () => {
      const existing = { id: 'e1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
      const spec = makeSpec({ buildings: [existing] });
      const state = makeState(spec);
      // Same tiles as the existing mine → overlap without the ignore.
      expect(validatePlacement(spec, state, 'mine', 0, 0, 0).reason).toBe('overlap');
      // Excluding the existing building's own footprint → geometry passes.
      expect(validatePlacement(spec, state, 'mine', 0, 0, 0, DEFAULT_GRAPH, 'e1').ok).toBe(true);
    });

    it('ignoreBuildingId still rejects overlap with a DIFFERENT building', () => {
      const a = { id: 'a', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
      const b = { id: 'b', defId: 'mine', x: 4, y: 0 } as PlacedBuilding;
      const spec = makeSpec({ buildings: [a, b] });
      const state = makeState(spec);
      // Ignoring 'a', but placing onto 'b' at (4,0) still overlaps b.
      expect(validatePlacement(spec, state, 'mine', 4, 0, 0, DEFAULT_GRAPH, 'a').reason).toBe('overlap');
    });

    it('skipCostGate bypasses the affordability gate', () => {
      const spec = makeSpec();
      const state = makeState(spec);
      state.inventory.stone = 0;
      state.inventory.wood = 0;
      // mine costs stone+wood → without skip, insufficient-resources.
      expect(validatePlacement(spec, state, 'mine', 0, 0, 0).reason).toBe('insufficient-resources');
      // skipCostGate true (8th arg) → geometry-only validation passes.
      expect(validatePlacement(spec, state, 'mine', 0, 0, 0, DEFAULT_GRAPH, undefined, true).ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// placeBuilding
// ---------------------------------------------------------------------------
/** Helper — asserts the `placeBuilding` result is a success and returns
 *  the placed building. Lets the existing test body keep its terse
 *  property-access pattern without a discriminator check on every line. */
function expectPlaced(
  result: ReturnType<typeof placeBuilding>,
): PlacedBuilding {
  if (!result.ok) {
    throw new Error(`expected placeBuilding ok, got reason=${result.reason}`);
  }
  return result.placed;
}

describe('placeBuilding', () => {
  it('appends a PlacedBuilding to spec.buildings (which state.buildings shares)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const placed = expectPlaced(placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-1'));
    expect(placed).toMatchObject({ id: 'p-1', defId: 'mine', x: 0, y: 0, rotation: 0 });
    // §4.7 maintenance seeds: placedAt/maintainedAt default to state.lastTick;
    // operatingMs starts at 0. Test only asserts presence (the exact stamp
    // depends on state.lastTick, which the makeState helper picks).
    expect(placed.operatingMs).toBe(0);
    expect(placed.placedAt).toBe(state.lastTick);
    expect(placed.maintainedAt).toBe(state.lastTick);
    expect(spec.buildings).toHaveLength(1);
    expect(spec.buildings[0]).toBe(placed);
    // state.buildings is a live reference (NOT a copy) to spec.buildings,
    // so the same instance is visible from both sides.
    expect(state.buildings).toHaveLength(1);
    expect(state.buildings[0]).toBe(placed);
  });

  it('bumps storage caps when placing a generic Crate (only the cargoLabel resource)', () => {
    // §4.6: Crate is generic storage — it bumps only the resource named on
    // its `cargoLabel`. `placeBuilding` defaults the label to iron_ore.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    const placed = expectPlaced(placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'p-crate'));
    expect(placed.cargoLabel).toBe('iron_ore');
    // iron_ore bumps by +500; every other resource stays at baseline.
    expect(state.storageCaps.iron_ore).toBe((before.iron_ore ?? 0) + 500);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      if (r === 'iron_ore') continue;
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  // -------------------------------------------------------------------------
  // §4.6 placement-time cargo-label picker — `cargoLabelOverride` argument
  // -------------------------------------------------------------------------
  it('honours a placement-time cargoLabelOverride for generic Crate (copper_ore example)', () => {
    // §4.6: placement-time picker passes the player's choice through.
    // Verifying the Crate is created with the chosen label AND the storage-
    // cap bump lands on that label, not the default iron_ore fallback.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    const placed = expectPlaced(
      placeBuilding(
        spec,
        state,
        'crate',
        0,
        0,
        0,
        () => 'p-crate-copper',
        undefined,
        'copper_ore',
      ),
    );
    expect(placed.cargoLabel).toBe('copper_ore');
    // copper_ore bumps by +500; iron_ore stays at baseline since the
    // default fallback was overridden.
    expect(state.storageCaps.copper_ore).toBe((before.copper_ore ?? 0) + 500);
    expect(state.storageCaps.iron_ore).toBe(before.iron_ore);
  });

  it('falls back to DEFAULT_CARGO_LABEL when cargoLabelOverride is omitted on a generic Crate', () => {
    // §4.6 backward-compat: programmatic placement that bypasses the picker
    // (synthetic test fixtures, scripted seeds) still gets a sensible
    // default. Mirrors today's pre-picker behaviour so no fixture had to
    // change after the picker landed.
    const spec = makeSpec();
    const state = makeState(spec);
    const placed = expectPlaced(
      placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'p-crate-default'),
    );
    expect(placed.cargoLabel).toBe('iron_ore');
  });

  it('ignores cargoLabelOverride on a non-generic-storage def (Mine carries no cargoLabel)', () => {
    // §4.6 only applies to generic-category storage. Passing the override
    // to a Mine (no storage at all) or a specialized Silo (category-routed)
    // must not somehow stamp a cargoLabel onto the placed building.
    const spec = makeSpec();
    const state = makeState(spec);
    const mine = expectPlaced(
      placeBuilding(
        spec,
        state,
        'mine',
        0,
        0,
        0,
        () => 'p-mine-no-label',
        undefined,
        'copper_ore',
      ),
    );
    expect(mine.cargoLabel).toBeUndefined();
    // Same for a specialized Silo — the override is silently dropped because
    // the def routes by storage.category, not by label.
    (mine as { constructionRemainingMs?: number }).constructionRemainingMs = 0;
    const silo = expectPlaced(
      placeBuilding(
        spec,
        state,
        'silo',
        4,
        0,
        0,
        () => 'p-silo-no-label',
        undefined,
        'copper_ore',
      ),
    );
    expect(silo.cargoLabel).toBeUndefined();
  });

  it('bumps category-matching caps when placing a specialized Silo (dry_goods only)', () => {
    // §4.6: Silo is specialized for dry_goods. Bumps every dry_goods resource
    // by +200000, leaves every other category at baseline.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    expectPlaced(placeBuilding(spec, state, 'silo', 0, 0, 0, () => 'p-silo'));
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      const expected =
        RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods'
          ? (before[r] ?? 0) + 200000
          : before[r];
      expect(state.storageCaps[r]).toBe(expected);
    }
  });

  it('bumps category-matching caps when placing a specialized Tank (liquid_gas only)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    expectPlaced(placeBuilding(spec, state, 'tank', 0, 0, 0, () => 'p-tank'));
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      const expected =
        RESOURCE_STORAGE_CATEGORY[r] === 'liquid_gas'
          ? (before[r] ?? 0) + 100000
          : before[r];
      expect(state.storageCaps[r]).toBe(expected);
    }
  });

  it('leaves storage caps unchanged when placing a non-storage def', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    expectPlaced(placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine'));
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('uses the provided id generator (called once per placement)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Two consecutive placements would normally hit the 1-slot parallel-build
    // cap; manually free the first slot by completing its construction before
    // placing the second (mirrors what the ticker does after T1's 30s base).
    let calls = 0;
    const gen = (): string => {
      calls += 1;
      return `gen-${calls}`;
    };
    const p1 = expectPlaced(placeBuilding(spec, state, 'solar', 0, 0, 0, gen));
    (p1 as { constructionRemainingMs?: number }).constructionRemainingMs = 0;
    const p2 = expectPlaced(placeBuilding(spec, state, 'solar', 2, 0, 0, gen));
    expect(p1.id).toBe('gen-1');
    expect(p2.id).toBe('gen-2');
    expect(calls).toBe(2);
  });

  // -------------------------------------------------------------------------
  // §14 placement-cost gate
  // -------------------------------------------------------------------------
  it('deducts placement cost from inventory on success', () => {
    // Mine costs 200 stone + 80 wood. Starting from a generous inventory the
    // exact deltas should land in state.inventory.
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 300;
    state.inventory.wood = 200;
    expectPlaced(placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-cost-1'));
    expect(state.inventory.stone).toBe(100);
    expect(state.inventory.wood).toBe(120);
  });

  it('rejects placement with insufficient-resources when inventory is short', () => {
    // Mine costs 200 stone + 80 wood. Zero out everything → the basket fails.
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const result = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-fail-1');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'insufficient-resources') {
      expect(result.missing).toEqual({ stone: 200, wood: 80 });
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
    // No building was committed, no id was minted.
    expect(spec.buildings).toHaveLength(0);
  });

  it('multi-resource cost is all-or-nothing — rejects if missing any one resource', () => {
    // Coke Oven (T2): 15000 clay + 500 stone + 100 pipe. Player has clay +
    // pipe but is short on stone — should reject and report only the missing
    // stone in the shortfall.
    const spec = makeSpec();
    const state = makeState(spec, 5);
    state.inventory.clay = 20000;
    state.inventory.pipe = 200;
    state.inventory.stone = 200;
    const result = placeBuilding(spec, state, 'coke_oven', 0, 0, 0, () => 'p-fail-2');
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'insufficient-resources') {
      expect(result.missing).toEqual({ stone: 300 });
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    }
    // Clay / pipe NOT debited on the rejection branch.
    expect(state.inventory.clay).toBe(20000);
    expect(state.inventory.pipe).toBe(200);
    expect(spec.buildings).toHaveLength(0);
  });

  it('validatePlacement surfaces insufficient-resources after geometry checks', () => {
    // Mine costs 200 stone + 80 wood; with zero inventory the geometry-
    // ok placement should fail with insufficient-resources (not
    // out-of-bounds / overlap). Validator priority: geometry first,
    // resources LAST.
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const v = validatePlacement(spec, state, 'mine', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('insufficient-resources');
    expect(v.missing).toEqual({ stone: 200, wood: 80 });
  });

  it('battery_bank placement cost is saltwater_cell-based, not battery-based (§15.6)', () => {
    // §15.6 saltwater-cell bootstrap — battery_bank.placementCost is
    // { saltwater_cell:20, wire:15, steel_beam:5, lead_ingot:30 }, NOT the old
    // battery-token cost. Zeroing inventory pins the new shortfall shape so a
    // revert to the battery cost is caught. battery_bank is T2 — bump level.
    const spec = makeSpec();
    const state = makeState(spec, 11);
    state.inventory.saltwater_cell = 0;
    state.inventory.wire = 0;
    state.inventory.steel_beam = 0;
    state.inventory.lead_ingot = 0;
    state.inventory.battery = 0; // confirm the old token is NOT in the shortfall
    const v = validatePlacement(spec, state, 'battery_bank', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('insufficient-resources');
    expect(v.missing).toEqual({ saltwater_cell: 20, wire: 15, steel_beam: 5, lead_ingot: 30 });
  });
});

// ---------------------------------------------------------------------------
// buildingAtTile (§4 hit-test)
// ---------------------------------------------------------------------------
describe('buildingAtTile', () => {
  it('returns the building when the tile lies inside its footprint', () => {
    const b: PlacedBuilding = { id: 'm1', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const spec = makeSpec({ buildings: [b] });
    // Mine is 2×2 at (0,0). All four tiles should hit.
    expect(buildingAtTile(spec, 0, 0)).toBe(b);
    expect(buildingAtTile(spec, 1, 0)).toBe(b);
    expect(buildingAtTile(spec, 0, 1)).toBe(b);
    expect(buildingAtTile(spec, 1, 1)).toBe(b);
  });

  it('returns null when the tile is outside every footprint', () => {
    const b: PlacedBuilding = { id: 'm1', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const spec = makeSpec({ buildings: [b] });
    expect(buildingAtTile(spec, 2, 0)).toBeNull();
    expect(buildingAtTile(spec, 0, 2)).toBeNull();
    expect(buildingAtTile(spec, -1, -1)).toBeNull();
  });

  it('snaps fractional tile coords to the nearest tile (round, centred-tile convention)', () => {
    const b: PlacedBuilding = { id: 'm1', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const spec = makeSpec({ buildings: [b] });
    // 0.3 and 0.7 both round to the nearest integer within the 2×2 footprint.
    expect(buildingAtTile(spec, 0.7, 0.3)).toBe(b);
    // 2.1 rounds to 2 — outside the 2×2 at (0,0) which covers tiles 0 and 1.
    expect(buildingAtTile(spec, 2.1, 0)).toBeNull();
  });

  it('hit-tests the visual edges of a building (centred-tile rendering)', () => {
    // The home island uses TILE_PX = 24. Each tile (n) is rendered centred on
    // world pixel (n * 24), covering world pixels [n*24 - 12, n*24 + 12).
    // In fractional-tile coords, tile (n) spans [n - 0.5, n + 0.5).
    // A 2×2 Mine at (0,0) covers tiles {0,1} × {0,1}, so its visual footprint
    // spans fractional coords [-0.5, 1.5) in both axes.
    const b: PlacedBuilding = { id: 'm1', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const spec = makeSpec({ buildings: [b] });
    // Visual top-left corner: fractional (-0.49, -0.49) — inside the building.
    expect(buildingAtTile(spec, -0.49, -0.49)).toBe(b);
    // Visual bottom-right corner: fractional (1.49, 1.49) — inside the building.
    expect(buildingAtTile(spec, 1.49, 1.49)).toBe(b);
    // Just past the left visual edge: fractional (-0.51, 0) — outside.
    expect(buildingAtTile(spec, -0.51, 0)).toBeNull();
    // Just past the right visual edge: fractional (1.51, 0) — outside.
    expect(buildingAtTile(spec, 1.51, 0)).toBeNull();
  });

  it('respects rotation in the footprint tile set', () => {
    // electric_arc_furnace is 2×3. Under rotation 1 it occupies a 3×2 block
    // (per the rotatedDims tests above). Verify tile-set disambiguation.
    const b: PlacedBuilding = {
      id: 'eaf1',
      defId: 'electric_arc_furnace',
      x: 0,
      y: 0,
      rotation: 1,
    };
    const spec = makeSpec({ buildings: [b] });
    // Rotation-1 covers x∈[0..2], y∈[0..1]. Tile (2, 0) should hit, (0, 2)
    // should NOT (that's the rotation-0 layout).
    expect(buildingAtTile(spec, 2, 0)).toBe(b);
    expect(buildingAtTile(spec, 0, 2)).toBeNull();
  });

  it('returns the first matching building when buildings overlap (defensive)', () => {
    // Synthetic fixture — placement would normally reject overlap. Build two
    // entries at the same anchor and confirm first-match wins so behaviour
    // is predictable if a test or save fixture ever ships an overlap.
    const a: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 0, y: 0, rotation: 0 };
    const spec = makeSpec({ buildings: [a, b] });
    expect(buildingAtTile(spec, 0, 0)).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// demolishBuilding (§6.7)
// ---------------------------------------------------------------------------
describe('demolishBuilding', () => {
  it('returns not-found when the buildingId is absent', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const r = demolishBuilding(spec, state, 'no-such-id');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-found');
    expect(r.scrapReturned).toBe(0);
  });

  it('removes the building from spec.buildings on the happy path', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine');
    expect(spec.buildings).toHaveLength(1);
    const r = demolishBuilding(spec, state, 'p-mine');
    expect(r.ok).toBe(true);
    expect(spec.buildings).toHaveLength(0);
    // state.buildings is the same array reference — the splice mutation
    // shows up on both sides without an explicit sync.
    expect(state.buildings).toHaveLength(0);
  });

  it('credits scrap = floor(sum(placementCost) * 0.3) on success', () => {
    // solar 11 → 3; mine 280 → 84; blast_furnace 57000 → 17100.
    const cases: Array<{ defId: 'solar' | 'mine' | 'blast_furnace'; level: number; expected: number }> = [
      { defId: 'solar', level: 1, expected: 3 },
      { defId: 'mine', level: 1, expected: 84 },
      { defId: 'blast_furnace', level: 5, expected: 17100 },
    ];
    for (const c of cases) {
      const spec = makeSpec();
      const state = makeState(spec, c.level);
      state.storageCaps.scrap = 50000; // raise cap so scrap credit isn't clamped
      const pr = placeBuilding(spec, state, c.defId, 0, 0, 0, () => `p-${c.defId}`);
      expect(pr.ok).toBe(true);
      const beforeScrap = state.inventory.scrap ?? 0;
      const r = demolishBuilding(spec, state, `p-${c.defId}`);
      expect(r.ok).toBe(true);
      expect(r.scrapReturned).toBe(c.expected);
      expect(state.inventory.scrap).toBe(beforeScrap + c.expected);
    }
  });

  it('subtracts the storage contribution from category-matching resources when a Silo is demolished', () => {
    // §4.6: Silo is dry_goods-only — its demolition reverses the dry_goods
    // bump and leaves other categories untouched.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    placeBuilding(spec, state, 'silo', 0, 0, 0, () => 'p-silo');
    // Sanity: only dry_goods bumped.
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      const expected =
        RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods'
          ? (before[r] ?? 0) + 200000
          : before[r];
      expect(state.storageCaps[r]).toBe(expected);
    }
    const dem = demolishBuilding(spec, state, 'p-silo');
    expect(dem.ok).toBe(true);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('subtracts the storage contribution from only the cargoLabel resource when a Crate is demolished', () => {
    // §4.6: Crate is generic — demolition reverses only the cargoLabel's
    // bump, leaving every other resource at its baseline.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'p-crate');
    expect(state.storageCaps.iron_ore).toBe((before.iron_ore ?? 0) + 500);
    const dem = demolishBuilding(spec, state, 'p-crate');
    expect(dem.ok).toBe(true);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('leaves storage caps untouched when a non-storage def is demolished', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine');
    const beforeCaps = { ...state.storageCaps };
    demolishBuilding(spec, state, 'p-mine');
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(beforeCaps[r]);
    }
  });

  it('clamps inventory down to the new cap when a storage building is demolished', () => {
    // §4.6: "If current inventory of any affected resource now exceeds the
    // reduced cap, the excess is lost — inventory clamps down to the new
    // cap." Place a Silo (+200000 cap), fill iron_ore above the post-demolish
    // baseline cap (100 for dry_goods), then demolish and confirm the excess is dropped.
    const spec = makeSpec();
    const state = makeState(spec);
    placeBuilding(spec, state, 'silo', 0, 0, 0, () => 'p-silo');
    // Caps are now 200100 for dry_goods. Stuff iron_ore to 3000 (above post-demolish cap of 100).
    state.inventory.iron_ore = 3000;
    const r = demolishBuilding(spec, state, 'p-silo');
    expect(r.ok).toBe(true);
    // Cap dropped from 200100 → 100; inventory clamps to 100.
    expect(state.storageCaps.iron_ore).toBe(100);
    expect(state.inventory.iron_ore).toBe(100);
  });

  it('caps the credited scrap to the resource cap (no overfill)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Force the scrap cap low so the demolition credit hits it.
    state.storageCaps.scrap = 5;
    state.inventory.scrap = 0;
    // Mine costs 280 total → 84 scrap; the cap of 5 should clip it.
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine');
    const r = demolishBuilding(spec, state, 'p-mine');
    expect(r.ok).toBe(true);
    // Reported credit reflects the raw scrap returned per §6.7 formula —
    // the inventory clip is what gets lost, but the player feedback is the
    // full earned amount.
    expect(r.scrapReturned).toBe(84);
    expect(state.inventory.scrap).toBe(5);
  });

  // -------------------------------------------------------------------------
  // §14 50% placement-cost refund
  // -------------------------------------------------------------------------
  it('refunds 50% of placement cost (floored per-resource) on demolition', () => {
    // Mine cost: 200 stone + 80 wood. Demolish should refund 100 stone + 40
    // wood on top of the scrap credit.
    const spec = makeSpec();
    const state = makeState(spec);
    // Anchor inventory to known pre-place numbers so the post-demolish
    // delta is unambiguous. Raise caps so the refund isn't clamped.
    state.storageCaps.stone = 1000;
    state.storageCaps.wood = 1000;
    state.inventory.stone = 300;
    state.inventory.wood = 200;
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine-refund');
    // After place: 300 - 200 = 100 stone, 200 - 80 = 120 wood.
    expect(state.inventory.stone).toBe(100);
    expect(state.inventory.wood).toBe(120);
    const r = demolishBuilding(spec, state, 'p-mine-refund');
    expect(r.ok).toBe(true);
    expect(r.refunded).toEqual({ stone: 100, wood: 40 });
    // After refund: 100 + 100 = 200 stone, 120 + 40 = 160 wood.
    expect(state.inventory.stone).toBe(200);
    expect(state.inventory.wood).toBe(160);
  });

  it('refund clamps to resource cap (excess refund is lost like production overflow)', () => {
    // Place a Mine (cost 200 stone + 80 wood), then artificially raise stone
    // close to its cap so the +100 refund only partially lands.
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 300;
    state.inventory.wood = 200;
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine-cap');
    // Force stone cap low — anything past cap is lost on refund.
    state.storageCaps.stone = 75;
    state.inventory.stone = 70;
    const r = demolishBuilding(spec, state, 'p-mine-cap');
    expect(r.ok).toBe(true);
    // Refund would be 100 stone, but cap-headroom is only 5. The reported
    // refunded number reflects what ACTUALLY landed (5), not the raw 100.
    expect(r.refunded.stone).toBe(5);
    expect(state.inventory.stone).toBe(75); // clamped
  });

  it('refund and scrap scale with floor level', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0, floorLevel: 2 } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1] });
    const state = makeState(spec);
    // Ensure headroom so refund/scrap aren't cap-clamped, and empty stockpiles.
    state.storageCaps.scrap = 50000;
    state.storageCaps.stone = 50000;
    state.storageCaps.wood = 50000;
    state.inventory.scrap = 0;
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const r = demolishBuilding(spec, state, 'm1');
    expect(r.ok).toBe(true);
    // floor 2 total: stone 200+2×160=520, wood 80+2×64=208.
    // refund floor(/2): stone 260, wood 104. scrap floor(0.3×728)=218.
    expect(r.refunded).toEqual({ stone: 260, wood: 104 });
    expect(r.scrapReturned).toBe(218);
  });

  it('floor 0 matches the base-cost refund/scrap values', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding; // floor 0
    const spec = makeSpec({ buildings: [m1] });
    const state = makeState(spec);
    state.storageCaps.scrap = 50000;
    state.storageCaps.stone = 50000;
    state.storageCaps.wood = 50000;
    state.inventory.scrap = 0;
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const r = demolishBuilding(spec, state, 'm1');
    expect(r.ok).toBe(true);
    expect(r.refunded).toEqual({ stone: 100, wood: 40 }); // floor(0.5 × {200,80})
    expect(r.scrapReturned).toBe(84); // floor(0.3 × 280)
  });
});

describe('§8.8 coastal placement', () => {
  function terrainAt(x: number, y: number): TerrainKind {
    // 2×2 water patch at (0,0), (0,1), (1,0), (1,1); rest is grass
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return 'water';
    return 'grass';
  }

  it('allows shipyard when at least one tile is water', () => {
    const spec = makeSpec({ terrainAt });
    const state = makeState(spec);
    // Place 3×3 shipyard so its footprint covers the 2×2 water patch
    const result = validatePlacement(spec, state, 'shipyard', 0, 0, 0);
    expect(result.ok).toBe(true);
  });

  it('rejects shipyard when no tile is water', () => {
    const spec = makeSpec({ terrainAt });
    const state = makeState(spec);
    // Shift inside the island but far from the water patch
    const result = validatePlacement(spec, state, 'shipyard', 5, 5, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('tile-requirement-not-met');
  });
});

describe('§6.7 scrap recovery', () => {
  it('returns scrap proportional to build cost, not footprint area', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-mine');
    const mineDef = BUILDING_DEFS.mine;
    const costSum = Object.values(placementCostFor(mineDef)).reduce((a, b) => a + b, 0);
    const expectedScrap = Math.floor(costSum * 0.3);
    const result = demolishBuilding(spec, state, state.buildings[state.buildings.length - 1]!.id);
    expect(result.ok).toBe(true);
    expect(result.scrapReturned).toBe(expectedScrap);
  });

  it('floors scrap from cost × 0.3', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // workshop costs { wood: 150, stone: 100, iron_ingot: 30 } → sum 280 → 280*0.3 = 84.0
    placeBuilding(spec, state, 'workshop', 0, 0, 0, () => 'p-workshop');
    const result = demolishBuilding(spec, state, state.buildings[state.buildings.length - 1]!.id);
    expect(result.scrapReturned).toBe(84);
  });
});

// ---------------------------------------------------------------------------
// §3 / §4 ocean building footprint + anchor validation
// ---------------------------------------------------------------------------
// The ocean placement pipeline is a sibling validator (`validateOceanPlacement`)
// from the land flow above. Cells (NOT tile coords) are the unit; terrain
// gating reads `world.oceanCells`; anchor-in-range gating reads
// `world.islands`. UI wiring of the anchor picker is deferred — these tests
// pin the pure data-layer validator only.

import { validateOceanPlacement } from './placement.js';
import { CELL_SIZE_TILES } from './constants.js';
import { ANCHOR_MAX_RANGE_CELLS } from './anchor-picker.js';
import type { WorldState } from './world.js';
import type { OceanCellSpec, OceanTerrain } from './ocean-cell.js';

/** Minimal `WorldState` stub for ocean validation tests — only `oceanCells`
 *  and `islands` are read. Same `unknown` cast pattern used by
 *  `anchor-picker.test.ts:worldWith`. */
function makeOceanWorld(
  oceanCells: Map<string, OceanCellSpec>,
  islands: IslandSpec[],
): WorldState {
  return { oceanCells, islands, recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() } as unknown as WorldState;
}

/** Build a `Map<cellKey, OceanCellSpec>` from a list of (cellX, cellY,
 *  terrain) triples. Cells NOT listed default to `deep` via the
 *  `terrainAt` implicit fallback — same convention as world-gen. */
function oceanCells(
  entries: ReadonlyArray<readonly [number, number, OceanTerrain]>,
): Map<string, OceanCellSpec> {
  const m = new Map<string, OceanCellSpec>();
  for (const [x, y, t] of entries) m.set(`${x},${y}`, { terrain: t });
  return m;
}

/** A populated island at cell-equivalent tile coords near (0,0) — within
 *  ANCHOR_MAX_RANGE_CELLS of any cell at (0..10, 0..10). The placement
 *  validator only consults `populated` + `cx` + `cy` via `candidateAnchors`,
 *  so the other fields can stay default. */
function nearbyPopulatedIsland(): IslandSpec {
  return makeSpec({
    id: 'home',
    name: 'Home',
    populated: true,
    cx: 0,
    cy: 0,
  });
}

describe('totalInvestedCost', () => {
  const mineDef = BUILDING_DEFS.mine; // placementCost { stone: 200, wood: 80 }

  it('floor 0 (explicit) → base placement cost', () => {
    const b = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 0 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 200, wood: 80 });
  });

  it('floor 3 → base + 3 × ceil(0.8 × base) per resource', () => {
    // per-floor upgrade = ceil(0.8×200)=160 stone, ceil(0.8×80)=64 wood.
    // floor 3: stone 200+3×160=680; wood 80+3×64=272.
    const b = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 3 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 680, wood: 272 });
  });

  it('undefined floorLevel is treated as 0', () => {
    const b = { id: 'm', defId: 'mine', x: 0, y: 0 } as never;
    expect(totalInvestedCost(b, mineDef)).toEqual({ stone: 200, wood: 80 });
  });
});

describe('§3 ocean building footprint validation', () => {
  it('rejects Vent Tap placement when footprint extends beyond a vent cluster', () => {
    // Vent Tap is 2×2 cells (`SHAPES.square2`), terrainReqs: ['hydrothermal_vent'].
    // Stage a 2×2 vent cluster at cells (5,5)-(6,6) but only mark 3 of the 4
    // cells — the (6,6) corner stays implicit `deep`. The footprint
    // (cellX=5, cellY=5) covers all 4 cells; one is deep → terrain-mismatch.
    const cells = oceanCells([
      [5, 5, 'hydrothermal_vent'],
      [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'],
      // (6, 6) intentionally NOT listed → implicit deep.
    ]);
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'vent_tap', 5, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('terrain-mismatch');
  });

  it('accepts Vent Tap on a contiguous 2x2 vent cluster', () => {
    const cells = oceanCells([
      [5, 5, 'hydrothermal_vent'],
      [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'],
      [6, 6, 'hydrothermal_vent'],
    ]);
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'vent_tap', 5, 5);
    expect(v.ok).toBe(true);
  });

  it('accepts Open-Water Extractor on a shallows OR deep mixed footprint', () => {
    // Open-Water Extractor's terrainReqs = ['shallows', 'deep']. A footprint
    // mixing the two terrains is valid because every cell still lies in the
    // allowed set. (2 shallows + 2 deep — deep cells stay implicit.)
    const cells = oceanCells([
      [5, 5, 'shallows'],
      [6, 5, 'shallows'],
      // (5, 6) + (6, 6) implicit `deep` — still in the allowed set.
    ]);
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'open_water_extractor', 5, 5);
    expect(v.ok).toBe(true);
  });

  it('rejects Seawater Intake Rig on a footprint that includes any non-shallows cell', () => {
    // Seawater Intake's terrainReqs = ['shallows'] (single terrain). The
    // sibling cell at (6, 5) being a hydrothermal_vent (or anything other
    // than shallows) rejects.
    const cells = oceanCells([
      [5, 5, 'shallows'],
      [6, 5, 'hydrothermal_vent'],
      [5, 6, 'shallows'],
      [6, 6, 'shallows'],
    ]);
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'seawater_intake_rig', 5, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('terrain-mismatch');
  });

  it('rejects placement when no populated island sits within ANCHOR_MAX_RANGE_CELLS', () => {
    // Stage a valid 2×2 vent cluster; the only populated island is very far
    // away — outside the anchor range. `candidateAnchors` returns empty →
    // `no-anchor-in-range`.
    const cells = oceanCells([
      [5, 5, 'hydrothermal_vent'],
      [6, 5, 'hydrothermal_vent'],
      [5, 6, 'hydrothermal_vent'],
      [6, 6, 'hydrothermal_vent'],
    ]);
    const farIsland = makeSpec({
      id: 'far',
      name: 'Far',
      populated: true,
      cx: (ANCHOR_MAX_RANGE_CELLS + 50) * CELL_SIZE_TILES,
      cy: 0,
    });
    const world = makeOceanWorld(cells, [farIsland]);
    const v = validateOceanPlacement(world, 'vent_tap', 5, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('no-anchor-in-range');
  });

  it('rejects a non-ocean def as def-not-ocean (defensive routing guard)', () => {
    // Mine is a land building (no `oceanPlacement` flag). Calling the
    // ocean validator with it returns `def-not-ocean` rather than silently
    // accepting — surfaces test-side routing bugs fast.
    const world = makeOceanWorld(new Map(), [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'mine', 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-ocean');
  });

  it('accepts Nodule Harvester on a contiguous 2x2 nodule cluster', () => {
    // Nodule Harvester's terrainReqs = ['nodule_field']. The §3 design notes
    // nodule fields are 3×3 cell clusters; a 2×2 footprint comfortably fits.
    const cells = oceanCells([
      [10, 10, 'nodule_field'],
      [11, 10, 'nodule_field'],
      [10, 11, 'nodule_field'],
      [11, 11, 'nodule_field'],
    ]);
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'nodule_harvester', 10, 10);
    expect(v.ok).toBe(true);
  });

  it('§3 rejects Open-Water Extractor when footprint overlaps an island (land-overlap)', () => {
    // Open-Water Extractor's terrainReqs = ['shallows', 'deep']. Without the
    // land-overlap guard the placement would pass: cells inside an island's
    // tile grid aren't stored in `world.oceanCells`, so `terrainAt` defaults
    // them to `'deep'` (in the allowed set) and the terrain match silently
    // succeeds. Stage a 2×2 footprint anchored at cell (0,0) — tile (0,0)
    // lies inside the home island's r=14 ellipse, so the land-overlap
    // sampler rejects before the terrain match runs.
    const cells = oceanCells([]); // empty — every cell defaults to `deep`
    const world = makeOceanWorld(cells, [nearbyPopulatedIsland()]);
    const v = validateOceanPlacement(world, 'open_water_extractor', 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('land-overlap');
  });
});

describe('§3 land validator defense-in-depth', () => {
  it('§3 land validator rejects ocean defs (defense-in-depth)', () => {
    // Buildings-ui.ts filters ocean defs out of the land catalog UI, but a
    // programmatic / test caller could still reach `validatePlacement` with
    // an ocean def. The validator returns `def-is-ocean` FIRST — before
    // tier / biome / geometry — so the routing bug isn't masked by another
    // gate. Pick a tile (5, 5) inside the r=14 home spec to ensure no
    // geometry pre-empts the ocean check. vent_tap is T4; even at level 1
    // the result must be `def-is-ocean`, not `def-not-unlocked`.
    const spec = makeSpec();
    const state = makeState(spec);
    const result = validatePlacement(spec, state, 'vent_tap', 5, 5, 0);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('def-is-ocean');
  });
});

// ---------------------------------------------------------------------------
// §6 findOceanBuildingAt — ocean platform click-to-inspect helper
// ---------------------------------------------------------------------------
// Ocean platforms sit OUTSIDE any island ellipse — `buildingAtTile` won't
// reach them because the main.ts click handler gates buildingAtTile on
// `findPopulatedIslandAt`. This helper walks every populated island's
// `buildings[]` (ocean platforms are stored on their *anchor's* array per
// Task 10 architectural call) and bbox-tests each ocean def's world-tile
// footprint against the clicked tile.
//
// Critical: ocean def footprint dims are in *cell* units (e.g.
// SHAPES.single = 1×1 cells, SHAPES.square2 = 2×2 cells). The world-tile
// bbox extent is `shapeWidth * CELL_SIZE_TILES` × `shapeHeight * CELL_SIZE_TILES`.

describe('§6 findOceanBuildingAt', () => {
  /** Construct a populated island with a single ocean platform anchored on
   *  it. Mirrors the placement-ui.ts ocean attemptCommit path:
   *  `localX = cellX * CELL_SIZE_TILES - anchor.cx`, `localY = ..` — so the
   *  building's world-tile origin lines up with the cell-aligned coord. */
  function makeAnchorWithOceanBuilding(
    anchorCx: number,
    anchorCy: number,
    cellX: number,
    cellY: number,
    defId: 'sonar_buoy' | 'vent_tap',
  ): IslandSpec {
    const localX = cellX * CELL_SIZE_TILES - anchorCx;
    const localY = cellY * CELL_SIZE_TILES - anchorCy;
    const placed: PlacedBuilding = {
      id: `${defId}@${cellX},${cellY}`,
      defId,
      x: localX,
      y: localY,
      rotation: 0,
      placedAt: 0,
      operatingMs: 0,
      maintainedAt: 0,
      anchorIslandId: 'home',
    };
    return makeSpec({
      id: 'home',
      cx: anchorCx,
      cy: anchorCy,
      populated: true,
      buildings: [placed],
    });
  }

  it('returns the ocean platform whose footprint contains the world tile (1×1 cell sonar_buoy spans 16×16 tiles)', () => {
    // Sonar Buoy at cell (10, 5) — anchor at island centre (0, 0).
    // World-tile origin: (160, 80). 1×1 cells → 16×16 tile bbox.
    const spec = makeAnchorWithOceanBuilding(0, 0, 10, 5, 'sonar_buoy');
    // Click at the bbox top-left tile → hits the buoy.
    const hit1 = findOceanBuildingAt([spec], 160, 80);
    expect(hit1).not.toBe(null);
    expect(hit1?.building.defId).toBe('sonar_buoy');
    // Click in the middle of the 16×16 bbox → still hits.
    const hit2 = findOceanBuildingAt([spec], 168, 88);
    expect(hit2?.building.defId).toBe('sonar_buoy');
    // Click at the inclusive far corner (175, 95) → still inside the
    // [160, 176) × [80, 96) bbox.
    const hit3 = findOceanBuildingAt([spec], 175, 95);
    expect(hit3?.building.defId).toBe('sonar_buoy');
  });

  it('returns null when no ocean platform contains the tile', () => {
    const spec = makeAnchorWithOceanBuilding(0, 0, 10, 5, 'sonar_buoy');
    // World tile (0, 0) is far from the buoy's bbox at (160..176, 80..96).
    expect(findOceanBuildingAt([spec], 0, 0)).toBe(null);
    // Just outside the bbox on the +x side.
    expect(findOceanBuildingAt([spec], 176, 88)).toBe(null);
    // Just outside on the -y side.
    expect(findOceanBuildingAt([spec], 168, 79)).toBe(null);
  });

  it('respects ocean footprint dims in CELL units (2×2 cell vent_tap spans 32×32 tiles)', () => {
    const spec = makeAnchorWithOceanBuilding(0, 0, 4, 4, 'vent_tap');
    // World-tile origin: (64, 64). 2×2 cells → 32×32 tile bbox = [64, 96).
    expect(findOceanBuildingAt([spec], 64, 64)?.building.defId).toBe('vent_tap');
    expect(findOceanBuildingAt([spec], 80, 80)?.building.defId).toBe('vent_tap');
    expect(findOceanBuildingAt([spec], 95, 95)?.building.defId).toBe('vent_tap');
    // One tile past the bbox on +x.
    expect(findOceanBuildingAt([spec], 96, 80)).toBe(null);
  });

  it('iterates across multiple anchor islands when checking', () => {
    const spec1 = makeAnchorWithOceanBuilding(0, 0, 10, 5, 'sonar_buoy');
    const spec2: IslandSpec = (() => {
      // Second anchor far away at (1000, 1000) with a buoy at cell (62, 62)
      // → world-tile origin (992, 992).
      const localX = 62 * CELL_SIZE_TILES - 1000;
      const localY = 62 * CELL_SIZE_TILES - 1000;
      const placed: PlacedBuilding = {
        id: 'sonar2',
        defId: 'sonar_buoy',
        x: localX,
        y: localY,
        rotation: 0,
        placedAt: 0,
        operatingMs: 0,
        maintainedAt: 0,
        anchorIslandId: 'island2',
      };
      return makeSpec({
        id: 'island2',
        cx: 1000,
        cy: 1000,
        populated: true,
        buildings: [placed],
      });
    })();
    // Clicking at the second island's buoy bbox finds it (despite spec1
    // being first in the array).
    const hit = findOceanBuildingAt([spec1, spec2], 1000, 1000);
    expect(hit?.spec.id).toBe('island2');
    expect(hit?.building.id).toBe('sonar2');
  });

  it('ignores unpopulated islands (their buildings are not interactable)', () => {
    const spec = makeAnchorWithOceanBuilding(0, 0, 10, 5, 'sonar_buoy');
    // Mutate spec.populated to false — the click helper should skip it
    // (mirrors `findPopulatedIslandAt`'s populated-only gate).
    (spec as { populated: boolean }).populated = false;
    expect(findOceanBuildingAt([spec], 168, 88)).toBe(null);
  });

  it('ignores land buildings (oceanPlacement !== true)', () => {
    // A solar panel placed on the island shouldn't match the ocean click
    // path — even if its world-tile bbox happened to contain the click.
    const placed: PlacedBuilding = {
      id: 'solar1',
      defId: 'solar',
      x: 0,
      y: 0,
      rotation: 0,
      placedAt: 0,
      operatingMs: 0,
      maintainedAt: 0,
    };
    const spec = makeSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      populated: true,
      buildings: [placed],
    });
    expect(findOceanBuildingAt([spec], 0, 0)).toBe(null);
  });
});


describe('placement — terrain_modifier brush', () => {
  function makeSpec(): IslandSpec {
    return attachTerrainAt({
      id: 'test', name: 'test', cx: 0, cy: 0, majorRadius: 20, minorRadius: 20,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
  }

  it('accepts a clean 16-tile brush over empty terrain', () => {
    const spec = makeSpec();
    const state = makeState(spec, 5); // terrain_modifier is T2
    state.inventory.steel = 100; state.inventory.gear = 100;
    const v = validatePlacement(spec, state, 'terrain_modifier', 0, 0, 0);
    expect(v.ok).toBe(true);
  });

  it('aborts when an existing building sits under a ring tile', () => {
    const spec = makeSpec();
    const state = makeState(spec, 5); // terrain_modifier is T2
    // Place a 1×1 building at (-1, -1) — a ring tile of a modifier at (0,0).
    state.buildings.push({
      id: 'b1', defId: 'workshop', x: -1, y: -1, rotation: 0,
    });
    state.inventory.steel = 100; state.inventory.gear = 100;
    const v = validatePlacement(spec, state, 'terrain_modifier', 0, 0, 0);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('overlap');
  });

  it('does NOT abort when a brush tile lies outside the ellipse', () => {
    // A very small island where the ring spills off the edge.
    const spec = attachTerrainAt({
      id: 'tiny', name: 'tiny', cx: 0, cy: 0, majorRadius: 2, minorRadius: 2,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeState(spec, 5); // terrain_modifier is T2
    state.inventory.steel = 100; state.inventory.gear = 100;
    const v = validatePlacement(spec, state, 'terrain_modifier', 0, 0, 0);
    // Out-of-ellipse ring tiles are skipped at shot time, not rejected at
    // placement: a ring spilling off the edge is NOT an 'overlap' failure.
    if (!v.ok) expect(v.reason).not.toBe('overlap');
  });
});


// ---------------------------------------------------------------------------
// biomeBypass + tierBypass (Task 11)
// ---------------------------------------------------------------------------

describe('biomeBypass in validatePlacement', () => {
  it('rejects biome-locked building on wrong biome without bypass', () => {
    const spec = makeSpec({ biome: 'plains' });
    const state = makeState(spec, 30); // T4 level
    const v = validatePlacement(spec, state, 'pyroforge', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('biome-locked');
  });

  it('allows biome-locked building on wrong biome with bypass', () => {
    const spec = makeSpec({ biome: 'plains' });
    const state = makeState(spec, 30);
    const graph: Graph = {
      nodes: [
        {
          id: 'bypass.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'biomeBypass', buildings: ['pyroforge'] },
          description: 'bypass',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    state.unlockedNodes.add('bypass.1');
    const v = validatePlacement(spec, state, 'pyroforge', 0, 0, 0, graph);
    expect(v.ok).toBe(true);
  });

  it('allows biome-locked building on correct biome without bypass', () => {
    const spec = makeSpec({ biome: 'volcanic' });
    const state = makeState(spec, 30);
    const v = validatePlacement(spec, state, 'pyroforge', 0, 0, 0);
    expect(v.ok).toBe(true);
  });
});

describe('tierBypass in validatePlacement', () => {
  it('T3 building on level 4 island without bypass → def-not-unlocked', () => {
    const spec = makeSpec();
    const state = makeState(spec, 4); // tierForLevel(4) = 1
    const v = validatePlacement(spec, state, 'electric_arc_furnace', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-unlocked');
  });

  it('T3 building on level 4 island WITH tierShift=1 → still def-not-unlocked', () => {
    const spec = makeSpec();
    const state = makeState(spec, 4);
    const graph: Graph = {
      nodes: [
        {
          id: 'tier.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'tierBypass', buildings: ['electric_arc_furnace'], tierShift: 1 },
          description: 'tier bypass',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    state.unlockedNodes.add('tier.1');
    const v = validatePlacement(spec, state, 'electric_arc_furnace', 0, 0, 0, graph);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-unlocked');
  });

  it('T3 building on level 5 island without bypass → def-not-unlocked', () => {
    const spec = makeSpec();
    const state = makeState(spec, 5); // tierForLevel(5) = 2
    const v = validatePlacement(spec, state, 'electric_arc_furnace', 0, 0, 0);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-unlocked');
  });

  it('T3 building on level 5 island WITH tierShift=1 → ok', () => {
    const spec = makeSpec();
    const state = makeState(spec, 5);
    const graph: Graph = {
      nodes: [
        {
          id: 'tier.1',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'tierBypass', buildings: ['electric_arc_furnace'], tierShift: 1 },
          description: 'tier bypass',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    state.unlockedNodes.add('tier.1');
    const v = validatePlacement(spec, state, 'electric_arc_furnace', 0, 0, 0, graph);
    expect(v.ok).toBe(true);
  });

  it('T5 building is NOT bypassed by tierShift even with low level', () => {
    const spec = makeSpec();
    const state = makeState(spec, 5);
    state.aiCoreCrafted = false;
    const graph: Graph = {
      nodes: [
        {
          id: 'tier.2',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'tierBypass', buildings: ['casimir_tap'], tierShift: 1 },
          description: 'tier bypass t5',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    state.unlockedNodes.add('tier.2');
    const v = validatePlacement(spec, state, 'casimir_tap', 0, 0, 0, graph);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('def-not-unlocked');
  });

  it('T4 building on level 15 island WITH tierShift=1 → ok (tierForLevel(15)=3 >= 4-1)', () => {
    const spec = makeSpec();
    const state = makeState(spec, 15);
    const graph: Graph = {
      nodes: [
        {
          id: 'tier.3',
          subPath: 'mining',
          depth: 1,
          cost: 1,
          magnitude: 0.05,
          effect: { kind: 'tierBypass', buildings: ['fusion_core'], tierShift: 1 },
          description: 'tier bypass t4',
        },
      ],
      edges: [],
      bridges: [],
      graftSockets: [],
    };
    state.unlockedNodes.add('tier.3');
    const v = validatePlacement(spec, state, 'fusion_core', 0, 0, 0, graph);
    expect(v.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Floor-upgrade action (Task 3.4)
// ---------------------------------------------------------------------------

describe('upgradeCost', () => {
  it('returns each placementCost entry × 0.8', () => {
    // Mine: { stone: 200, wood: 80 } → ×0.8
    const mine = BUILDING_DEFS.mine;
    expect(upgradeCost(mine)).toEqual({ stone: 160, wood: 64 });
  });

  it('returns empty record for a def with no placementCost', () => {
    // Some legacy / free defs may lack placementCost.
    const def = { ...BUILDING_DEFS.mine, placementCost: undefined };
    expect(upgradeCost(def)).toEqual({});
  });

  it('rounds upgradeCost up to whole units', () => {
    // Real defs all have costs that are multiples of 5, so ×0.8 is integral.
    // Use a synthetic def with a non-÷5 entry to genuinely exercise the ceil.
    const def = { ...BUILDING_DEFS.mine, placementCost: { wood: 2 } };
    expect(upgradeCost(def)).toEqual({ wood: 2 }); // Math.ceil(2 * 0.8) = Math.ceil(1.6) = 2
  });
});

describe('upgradeConstructionMs', () => {
  it('returns base × (level + 1) for a T1 def', () => {
    const base = BASE_CONSTRUCTION_MS_BY_TIER[1];
    expect(upgradeConstructionMs(BUILDING_DEFS.mine, 1)).toBe(base * 2);
    expect(upgradeConstructionMs(BUILDING_DEFS.mine, 9)).toBe(base * 10);
  });

  it('returns base × (level + 1) for a T3 def', () => {
    const base = BASE_CONSTRUCTION_MS_BY_TIER[3];
    expect(upgradeConstructionMs(BUILDING_DEFS.capacitor_bank, 2)).toBe(base * 3);
    expect(upgradeConstructionMs(BUILDING_DEFS.capacitor_bank, 5)).toBe(base * 6);
  });
});

describe('applyUpgrade', () => {
  it('rejects when floorLevel is already 9 (max)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, floorLevel: 9 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('max-floor');
  });

  it('rejects with not-found when the buildingId is absent', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const r = applyUpgrade(spec, state, 'no-such-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  it('rejects when the target building is itself already under construction', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, constructionRemainingMs: 5000 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-building');
    expect(b.floorLevel).toBeUndefined(); // no mutation
  });

  it('enqueues (ok:true, queued=true) when the running cap is taken but queue has room', () => {
    // New contract (Task 6): running slots full + queue room → enqueue, not reject.
    const spec = makeSpec();
    const state = makeState(spec);
    // One OTHER building occupies the island's single (no-skill) build slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    const target: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(target);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    // floorLevel is advanced immediately (queued upgrade holds its level advance).
    expect(target.floorLevel).toBe(1);
    // queued flag is set on the building.
    expect(target.queued).toBe(true);
  });

  it('rejects with queue-full when BOTH running slots AND queue are full', () => {
    // Hard-reject still fires when there is truly no room anywhere.
    const spec = makeSpec();
    const state = makeState(spec);
    // Occupy the running slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    // Fill the queue (base capacity 2) with queued builds.
    const qSlots = queuedBuildSlots(state);
    for (let i = 0; i < qSlots; i++) {
      spec.buildings.push({ id: `qb${i}`, defId: 'mine', x: i * 3, y: 10, constructionRemainingMs: 1, queued: true });
    }
    const target: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(target);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('queue-full');
    expect(target.floorLevel).toBeUndefined(); // no mutation, no cost spent
  });

  it('rejects with insufficient-resources when inventory is short', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'insufficient-resources') {
      expect(r.missing).toEqual({ stone: 160, wood: 64 });
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(r)}`);
    }
    // No mutation on rejection.
    expect(b.floorLevel).toBeUndefined();
    expect(state.inventory.stone).toBe(0);
    expect(state.inventory.wood).toBe(0);
  });

  it('deducts upgradeCost and increments floorLevel on success', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 300;
    state.inventory.wood = 200;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(1);
    expect(state.inventory.stone).toBe(140); // 300 - 160
    expect(state.inventory.wood).toBe(136);  // 200 - 64
  });

  it('sets constructionRemainingMs > 0 so isOperational becomes false', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    // Pre-condition: no construction, so operational.
    expect((b.constructionRemainingMs ?? 0)).toBe(0);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.constructionRemainingMs).toBeGreaterThan(0);
  });

  it('adds +base capacity to storageCaps for a generic Crate (cargoLabel only)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'crate', x: 0, y: 0, cargoLabel: 'copper_ore' };
    spec.buildings.push(b);
    // Seed initial cap contribution from the placed crate at L0.
    const beforeCopper = (state.storageCaps.copper_ore ?? 0) + 500;
    state.storageCaps.copper_ore = beforeCopper;
    const beforeIron = state.storageCaps.iron_ore ?? 0;
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    // Delta is exactly +500 (base capacity).
    expect(state.storageCaps.copper_ore).toBe(beforeCopper + 500);
    // Unrelated resource untouched.
    expect(state.storageCaps.iron_ore).toBe(beforeIron);
  });

  it('adds +base capacity to storageCaps for a specialized Silo (category-wide)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'silo', x: 0, y: 0 };
    spec.buildings.push(b);
    // Seed initial cap contribution from the placed silo at L0.
    const beforeDry: Partial<Record<ResourceId, number>> = {};
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      if (RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods') {
        beforeDry[r] = (state.storageCaps[r] ?? 0) + 200000;
        state.storageCaps[r] = beforeDry[r]!;
      }
    }
    const beforeLiquid = state.storageCaps.fresh_water ?? 0;
    const result = applyUpgrade(spec, state, 'b1');
    expect(result.ok).toBe(true);
    // Every dry_goods resource gets +200000.
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      if (RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods') {
        expect(state.storageCaps[r]).toBe((beforeDry[r] ?? 0) + 200000);
      }
    }
    // Unrelated liquid_gas resource untouched.
    expect(state.storageCaps.fresh_water).toBe(beforeLiquid);
  });

  it('leaves storageCaps unchanged for a non-storage def', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const before = { ...state.storageCaps };
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    for (const r2 of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r2]).toBe(before[r2]);
    }
  });

  it('chains two upgrades (L0→L1→L2) deducting cost each time', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 1000;
    state.inventory.wood = 1000;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const r1 = applyUpgrade(spec, state, 'b1');
    expect(r1.ok).toBe(true);
    expect(b.floorLevel).toBe(1);
    // constructionRemainingMs set by first upgrade.
    (b as { constructionRemainingMs?: number }).constructionRemainingMs = 0;
    const r2 = applyUpgrade(spec, state, 'b1');
    expect(r2.ok).toBe(true);
    expect(b.floorLevel).toBe(2);
    // Deducted twice.
    expect(state.inventory.stone).toBe(1000 - 160 * 2);
    expect(state.inventory.wood).toBe(1000 - 64 * 2);
  });
});

describe('formatShortfall', () => {
  it('ceils fractional shortfalls — inventory trickles in fractions, players need whole units', () => {
    // The bug: a raw `needed - have` like 7.23154… rendered verbatim on the
    // floor-upgrade button. Round UP to the next whole unit.
    expect(formatShortfall({ stone: 7.23154524625235124 })).toBe('8 STONE');
  });

  it('formats multiple resources, uppercased with underscores spaced', () => {
    expect(formatShortfall({ stone: 2.1, pig_iron: 3 })).toBe('3 STONE, 3 PIG IRON');
  });

  it('skips non-positive entries and returns "" for an empty record', () => {
    expect(formatShortfall({})).toBe('');
    expect(formatShortfall({ stone: 0 })).toBe('');
  });
});

describe('relocateBuilding', () => {
  it('moves the building, charges floor(0.5 × total), preserves state', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0, constructionRemainingMs: 5000, disabled: true } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1] });
    const state = makeState(spec);
    const stone0 = state.inventory.stone;
    const wood0 = state.inventory.wood;
    const r = relocateBuilding(spec, state, 'm1', 4, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.charged).toEqual({ stone: 100, wood: 40 }); // floor(0.5 × {200,80})
    expect(state.inventory.stone).toBe(stone0 - 100);
    expect(state.inventory.wood).toBe(wood0 - 40);
    expect(spec.buildings.length).toBe(1);
    expect(m1.x).toBe(4);
    expect(m1.y).toBe(0);
    // "just teleport": all other state preserved
    expect(m1.constructionRemainingMs).toBe(5000);
    expect(m1.disabled).toBe(true);
    expect(m1.defId).toBe('mine');
  });

  it('allows a 1-tile shift overlapping its own current footprint', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1] });
    const state = makeState(spec);
    const r = relocateBuilding(spec, state, 'm1', 1, 0);
    expect(r.ok).toBe(true);
    expect(m1.x).toBe(1);
  });

  it('rejects overlap with another building (inventory + position unchanged)', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
    const m2 = { id: 'm2', defId: 'mine', x: 4, y: 0 } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1, m2] });
    const state = makeState(spec);
    const stone0 = state.inventory.stone;
    const r = relocateBuilding(spec, state, 'm1', 4, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('overlap');
    expect(m1.x).toBe(0);
    expect(state.inventory.stone).toBe(stone0);
  });

  it('rejects when destination fails the terrain requiredTile', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1], terrainAt: () => 'grass' });
    const state = makeState(spec);
    const r = relocateBuilding(spec, state, 'm1', 2, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('tile-requirement-not-met');
    expect(m1.x).toBe(0);
  });

  it('rejects insufficient-resources for the fee and does not move', () => {
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0 } as PlacedBuilding;
    const spec = makeSpec({ buildings: [m1] });
    const state = makeState(spec);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const r = relocateBuilding(spec, state, 'm1', 4, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('insufficient-resources');
    expect(m1.x).toBe(0);
  });

  it('returns not-found for an unknown id', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const r = relocateBuilding(spec, state, 'nope', 4, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });
});

describe('sortByFillDesc', () => {
  const fill = (m: Record<string, number>) => (r: ResourceId) => m[r] ?? 0;

  it('orders resources by fill % descending (fullest first)', () => {
    const out = sortByFillDesc(
      ['wood', 'stone', 'clay'] as ResourceId[],
      fill({ wood: 10, stone: 90, clay: 50 }),
    );
    expect(out).toEqual(['stone', 'clay', 'wood']);
  });

  it('breaks ties alphabetically so equal-fill rows are deterministic', () => {
    const out = sortByFillDesc(
      ['wood', 'clay', 'stone'] as ResourceId[],
      fill({ wood: 0, clay: 0, stone: 0 }),
    );
    expect(out).toEqual(['clay', 'stone', 'wood']);
  });

  it('does not mutate the input array', () => {
    const input = ['wood', 'stone'] as ResourceId[];
    sortByFillDesc(input, fill({ wood: 1, stone: 2 }));
    expect(input).toEqual(['wood', 'stone']);
  });
});


describe('terrain_modifier placement charges the conversion cost upfront', () => {
  it('deducts placementCost + conversionCostForTarget(target)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.microchip = 1000;       // placementCost needs 10
    state.inventory.copper_ore = 200000;    // cover the 129,600 copper conversion
    const beforeCopper = state.inventory.copper_ore;
    const r = placeBuilding(spec, state, 'terrain_modifier', 0, 0, 0, () => 'tm', undefined, undefined, undefined, 'copper_vein');
    expect(r.ok).toBe(true);
    expect(state.inventory.copper_ore).toBe(beforeCopper - (conversionCostForTarget('copper_vein').copper_ore ?? 0));
  });

  it('rejects placement when the conversion cost is unaffordable (no building added)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.microchip = 1000;
    state.inventory.copper_ore = 0;         // can't afford the 129,600 conversion
    const r = placeBuilding(spec, state, 'terrain_modifier', 0, 0, 0, () => 'tm', undefined, undefined, undefined, 'copper_vein');
    expect(r.ok).toBe(false);
    expect(spec.buildings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// queue capacities
// ---------------------------------------------------------------------------
describe('queue capacities', () => {
  it('base queuedBuildSlots is 2', () => {
    const spec = makeSpec();
    const s = makeState(spec);
    expect(queuedBuildSlots(s)).toBe(2);
  });
  it('inProgressBuildCount counts running only; queuedBuildCount counts queued', () => {
    const spec = makeSpec();
    const s = makeState(spec);
    s.buildings.push(
      { id: 'a', defId: 'mine', x: 0, y: 0, rotation: 0, constructionRemainingMs: 1000 },
      { id: 'b', defId: 'mine', x: 1, y: 0, rotation: 0, constructionRemainingMs: 1000, queued: true },
    );
    expect(inProgressBuildCount(s)).toBe(1);
    expect(queuedBuildCount(s)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// enqueue when slots full (Task 6)
// ---------------------------------------------------------------------------
describe('enqueue when slots full', () => {
  it('placeBuilding returns ok:true with queued=true and numeric queueSeq when running slots full but queue has room', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Occupy the single base parallel-build slot with an in-progress build.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    const stoneBefore = state.inventory.stone;
    const woodBefore = state.inventory.wood;
    // Mine costs 200 stone + 80 wood; seed is already plentiful.
    const r = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'q-1');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.placed.queued).toBe(true);
    expect(typeof r.placed.queueSeq).toBe('number');
    // Cost deducted at enqueue.
    expect(state.inventory.stone).toBe(stoneBefore - 200);
    expect(state.inventory.wood).toBe(woodBefore - 80);
  });

  it('second enqueue gets queueSeq one greater than the first (FIFO stamp increments via state.nextQueueSeq)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Occupy the single base slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    const r1 = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'q-2a');
    const r2 = placeBuilding(spec, state, 'mine', 10, 0, 0, () => 'q-2b');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) throw new Error('expected both ok');
    expect(r1.placed.queueSeq).toBeDefined();
    expect(r2.placed.queueSeq).toBeDefined();
    expect(r2.placed.queueSeq!).toBe(r1.placed.queueSeq! + 1);
  });

  it('placeBuilding hard-rejects when running slots full AND queue is full', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    // Occupy the single base running slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    // Fill the queue (base capacity 2) with 2 queued builds.
    const qSlots = queuedBuildSlots(state);
    for (let i = 0; i < qSlots; i++) {
      spec.buildings.push({ id: `q${i}`, defId: 'mine', x: i * 3, y: 10, constructionRemainingMs: 1, queued: true });
    }
    const r = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'q-overflow');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('queue-full');
    }
  });

  it('applyUpgrade returns ok:true with queued=true on the building when running slots full and queue has room', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 10000;
    state.inventory.wood = 10000;
    // Occupy the single base running slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    // The target building is NOT under construction itself.
    const target: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(target);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    // floorLevel was still incremented (queued upgrade holds its level advance).
    expect(target.floorLevel).toBe(1);
    // queued flag is set on the building.
    expect(target.queued).toBe(true);
  });

  it('applyUpgrade rejects with already-building when the target is already queued (no stacking)', () => {
    // Regression: a queued build has constructionRemainingMs > 0, so the
    // already-building guard must block a SECOND applyUpgrade — otherwise it
    // would stack floorLevel, re-grant storage, re-stamp queueSeq, and re-pay.
    // (No promotion logic exists yet — Task 7 — so a queued build stays queued
    // and is otherwise upgradeable repeatedly.)
    const spec = makeSpec();
    const state = makeState(spec);
    // A building that is already queued (queued upgrade in flight).
    const target: PlacedBuilding = {
      id: 'b1',
      defId: 'mine',
      x: 0,
      y: 0,
      floorLevel: 1,
      queued: true,
      constructionRemainingMs: 5000,
      queueSeq: 0,
    };
    spec.buildings.push(target);
    const floorBefore = target.floorLevel;
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('already-building');
    // No mutation: floorLevel unchanged.
    expect(target.floorLevel).toBe(floorBefore);
  });
});
