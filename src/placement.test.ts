// Pure-layer tests for §4 placement math: footprintTiles/rotatedDims rotation
// transform, validatePlacement rejection reasons, placeBuilding instance
// append + storage-cap bumps. Live-economy integration lives in economy.test.ts.

import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import { SHAPES } from './shape-mask.js';
import { activeFloors, rawFloorLevel, type PlacedBuilding } from './buildings.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { RESOURCE_STORAGE_CATEGORY, storageBaseFor } from './storage-categories.js';
import {
  applyRelabelStorageCap,
  applyUpgrade,
  buildingAtTile,
  cancelConstruction,
  countQueuedUpgrades,
  creditStorageCaps,
  demolishBuilding,
  findOceanBuildingAt,
  formatShortfall,
  inProgressBuildCount,
  placeBuilding,
  placementCostFor,
  promoteQueuedBuilds,
  queuedBuildCount,
  queuedBuildSlots,
  relocateBuilding,
  setBuildingActiveFloors,
  sortByFillDesc,
  topUpgradeLevel,
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

    it('accepts placement on absorbed-constituent land (extraEllipse) per SPEC §4.3', () => {
      const spec = makeSpec({
        majorRadius: 5,
        minorRadius: 5,
        extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 10, offsetY: 0 }],
      });
      const state = makeState(spec);
      // (12, 0) lies inside the extra ellipse (local to extra: (2, 0) inside r=5).
      expect(validatePlacement(spec, state, 'workshop', 12, 0, 0).ok).toBe(true);
    });

    it('rejects placement outside ALL constituents of a merged island', () => {
      const spec = makeSpec({
        majorRadius: 5,
        minorRadius: 5,
        extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 10, offsetY: 0 }],
      });
      const state = makeState(spec);
      // (20, 0) is outside both primary (r=5) and extra (centre at 10, r=5).
      const v = validatePlacement(spec, state, 'workshop', 20, 0, 0);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('out-of-bounds');
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

  it('does NOT bump storage caps at placement for a generic Crate (deferred to completion)', () => {
    // §storage-timing: storage caps are credited at construction COMPLETION,
    // not at placement commit. A freshly-placed Crate is under construction
    // and grants NO cap until it becomes operational. (Was: immediate +500
    // at placement; that model is removed.) Crate is generic storage — when
    // it does complete it bumps only the cargoLabel resource (default iron_ore).
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    const placed = expectPlaced(placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'p-crate'));
    expect(placed.cargoLabel).toBe('iron_ore');
    // Under construction → no cap credited yet. EVERY resource at baseline.
    // (The completion-time credit is exercised against the real advanceIsland
    // hook in economy.test.ts › "storage caps granted on construction
    // completion".)
    expect((placed.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  // -------------------------------------------------------------------------
  // §4.6 placement-time cargo-label picker — `cargoLabelOverride` argument
  // -------------------------------------------------------------------------
  it('honours a placement-time cargoLabelOverride for generic Crate (copper_ore example)', () => {
    // §4.6: placement-time picker passes the player's choice through. The
    // chosen label is stamped on the placed building immediately; the
    // storage-cap bump itself is DEFERRED to construction completion
    // (§storage-timing) — so here we only assert the label, not a cap change.
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
    // No cap credited at placement — building under construction.
    expect((placed.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    expect(state.storageCaps.copper_ore).toBe(before.copper_ore);
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

  it('does NOT bump caps at placement for a specialized Silo (deferred to completion)', () => {
    // §storage-timing: a freshly-placed Silo is under construction and
    // credits NO cap until it becomes operational. (Was: immediate +200000
    // across dry_goods at placement.) EVERY category stays at baseline here.
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    const placed = expectPlaced(placeBuilding(spec, state, 'silo', 0, 0, 0, () => 'p-silo'));
    expect((placed.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('does NOT bump caps at placement for a specialized Tank (deferred to completion)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const before = { ...state.storageCaps };
    const placed = expectPlaced(placeBuilding(spec, state, 'tank', 0, 0, 0, () => 'p-tank'));
    expect((placed.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
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

  it('stores constructionTotalMs equal to constructionRemainingMs on a fresh placement', () => {
    // This is the value the progress arc divides by; with a Robotics speed-up
    // it can differ from the unmultiplied base.
    const spec = makeSpec();
    const state = makeState(spec);
    const placed = expectPlaced(placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'p-total'));
    expect(placed.constructionRemainingMs).toBeGreaterThan(0);
    expect(placed.constructionTotalMs).toBe(placed.constructionRemainingMs);
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
    // bump and leaves other categories untouched. demolish targets FINISHED
    // buildings, so we plant an OPERATIONAL silo whose cap is aggregated at
    // init — placement no longer credits the cap (§storage-timing). Percentage
    // model: the dry_goods bump is 2000 × storageBaseFor(r) (= +200000 to a
    // base-100 dry good, but +10000 to foundation_kit at base 5).
    const spec = makeSpec({
      buildings: [{ id: 'p-silo', defId: 'silo', x: 0, y: 0 }],
    });
    const state = makeState(spec);
    // Baseline caps WITHOUT the silo's contribution (the post-demolish target).
    const before = { ...makeState(makeSpec()).storageCaps };
    // Sanity: only dry_goods bumped at init by the operational silo.
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      const expected =
        RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods'
          ? (before[r] ?? 0) + 2000 * storageBaseFor(r)
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
    // bump, leaving every other resource at its baseline. demolish targets
    // FINISHED buildings, so we plant an OPERATIONAL crate (init aggregates
    // its +500 cap) rather than placing a still-under-construction one
    // (§storage-timing: placement no longer credits the cap).
    const spec = makeSpec({
      buildings: [{ id: 'p-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' }],
    });
    const state = makeState(spec);
    // Baseline caps WITHOUT the crate's contribution (what we expect to land
    // back on after demolish): aggregate a building-free spec.
    const before = { ...makeState(makeSpec()).storageCaps };
    // Operational crate's +500 is present at init.
    expect(state.storageCaps.iron_ore).toBe((before.iron_ore ?? 0) + 500);
    const dem = demolishBuilding(spec, state, 'p-crate');
    expect(dem.ok).toBe(true);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('Crate contributes multiplier × per-resource base (percentage model)', () => {
    // §4.6 percentage storage: a storage building's `storage.capacity` is now a
    // MULTIPLIER, and the per-resource contribution is `mult × max(5, baseCap(r))`.
    // Crate mult = 5 → iron_ore (base 100) gets +500, bolt (base 20) gets +100.
    const base = { ...makeState(makeSpec()).storageCaps };
    const ironState = makeState(
      makeSpec({ buildings: [{ id: 'c-iron', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' }] }),
    );
    const boltState = makeState(
      makeSpec({ buildings: [{ id: 'c-bolt', defId: 'crate', x: 0, y: 0, cargoLabel: 'bolt' }] }),
    );
    expect(ironState.storageCaps.iron_ore).toBe((base.iron_ore ?? 0) + 500);
    expect(boltState.storageCaps.bolt).toBe((base.bolt ?? 0) + 100);
  });

  it('floors the storage base at 5 so zero-base ai_core stays storable', () => {
    // ai_core has base cap 0 (whole-unit-only). max(5, 0) = 5 keeps it storable:
    // a Vault (mult 1000) grants 1000 × 5 = 5000. The fresh-island BASELINE cap
    // stays literal at 0 (no storage building → cannot hold ai_core).
    expect(makeState(makeSpec()).storageCaps.ai_core).toBe(0);
    const vaultState = makeState(
      makeSpec({ buildings: [{ id: 'v', defId: 'vault', x: 0, y: 0 }] }),
    );
    expect(vaultState.storageCaps.ai_core).toBe(5000);
  });

  it('Crate demolish reverses the per-resource percentage contribution', () => {
    // Reverse of the credit: a Crate labeled bolt added +100, demolish strips it.
    const spec = makeSpec({
      buildings: [{ id: 'p-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'bolt' }],
    });
    const state = makeState(spec);
    const before = { ...makeState(makeSpec()).storageCaps };
    expect(state.storageCaps.bolt).toBe((before.bolt ?? 0) + 100);
    expect(demolishBuilding(spec, state, 'p-crate').ok).toBe(true);
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[r]).toBe(before[r]);
    }
  });

  it('relabel moves the percentage contribution between resources of different base', () => {
    // Relabel iron_ore → bolt: iron_ore loses 5×100=500, bolt gains 5×20=100.
    const spec = makeSpec({
      buildings: [{ id: 'p-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' }],
    });
    const state = makeState(spec);
    const before = { ...makeState(makeSpec()).storageCaps };
    expect(state.storageCaps.iron_ore).toBe((before.iron_ore ?? 0) + 500);
    const b = spec.buildings[0]!;
    const res = applyRelabelStorageCap(state, b, BUILDING_DEFS.crate, 'iron_ore', 'bolt');
    expect(res).toBe('moved');
    expect(state.storageCaps.iron_ore).toBe(before.iron_ore ?? 0);
    expect(state.storageCaps.bolt).toBe((before.bolt ?? 0) + 100);
  });

  it('relabel clamps old-resource inventory to the reduced cap, preserving stock below cap', () => {
    // Regression for #30: force-clear used to zero the entire old resource.
    // Now only the excess above the post-relabel cap is destroyed.
    const spec = makeSpec({
      buildings: [{ id: 'p-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' }],
    });
    const state = makeState(spec);
    const baselineIronCap = makeState(makeSpec()).storageCaps.iron_ore ?? 0;
    // Crate contribution gives +500; cap before relabel = baseline + 500.
    expect(state.storageCaps.iron_ore).toBe(baselineIronCap + 500);

    const b = spec.buildings[0]!;

    // Case 1: held stock is below the reduced cap — it must survive.
    state.inventory.iron_ore = 50;
    applyRelabelStorageCap(state, b, BUILDING_DEFS.crate, 'iron_ore', 'bolt');
    expect(state.storageCaps.iron_ore).toBe(baselineIronCap);
    expect(state.inventory.iron_ore).toBe(50);
  });

  it('relabel destroys only the excess when old-resource stock is above the reduced cap', () => {
    const spec = makeSpec({
      buildings: [{ id: 'p-crate', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' }],
    });
    const state = makeState(spec);
    const baselineIronCap = makeState(makeSpec()).storageCaps.iron_ore ?? 0;
    const b = spec.buildings[0]!;

    state.inventory.iron_ore = baselineIronCap + 200;
    applyRelabelStorageCap(state, b, BUILDING_DEFS.crate, 'iron_ore', 'bolt');
    expect(state.storageCaps.iron_ore).toBe(baselineIronCap);
    expect(state.inventory.iron_ore).toBe(baselineIronCap);
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
    // demolish targets FINISHED buildings; plant an OPERATIONAL silo so its
    // +200000 dry_goods cap is aggregated at init (§storage-timing: placement
    // no longer credits the cap up-front).
    const spec = makeSpec({
      buildings: [{ id: 'p-silo', defId: 'silo', x: 0, y: 0 }],
    });
    const state = makeState(spec);
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

  it('sums the exponential curve for floors beyond 10', () => {
    // floorLevel 10 → displayed 11; 9 legacy upgrades (floors 2..10) plus one exponential upgrade (floor 11).
    const b = { id: 'm', defId: 'mine', x: 0, y: 0, floorLevel: 10 } as never;
    const expected = {
      stone: 200 + 9 * 160 + upgradeCost(mineDef, 11).stone!,
      wood: 80 + 9 * 64 + upgradeCost(mineDef, 11).wood!,
    };
    expect(totalInvestedCost(b, mineDef)).toEqual(expected);
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

  it('rejects ocean-vs-ocean cell overlap from a different anchor', () => {
    // First platform: island A places a 1×1 sonar_buoy at cell (5, 5).
    const islandA = makeSpec({
      id: 'island-a',
      cx: 0,
      cy: 0,
      populated: true,
      buildings: [
        {
          id: 'buoy-a',
          defId: 'sonar_buoy',
          x: 5 * CELL_SIZE_TILES,
          y: 5 * CELL_SIZE_TILES,
          rotation: 0,
          placedAt: 0,
          operatingMs: 0,
          maintainedAt: 0,
          anchorIslandId: 'island-a',
        } as PlacedBuilding,
      ],
    });
    // Second anchor: island B is also within range of cell (5, 5).
    const islandB = makeSpec({
      id: 'island-b',
      cx: 10 * CELL_SIZE_TILES,
      cy: 0,
      populated: true,
      buildings: [],
    });
    const world = makeOceanWorld(new Map(), [islandA, islandB]);
    // Island B tries to place on the SAME cell — should be rejected.
    const v = validateOceanPlacement(world, 'sonar_buoy', 5, 5);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('ocean-overlap');
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

  it('keeps floors 2..10 priced at the legacy 0.8× rate', () => {
    const mine = BUILDING_DEFS.mine;
    for (let L = 2; L <= 10; L++) {
      expect(upgradeCost(mine, L)).toEqual({ stone: 160, wood: 64 });
    }
  });

  it('prices floor 11, 12, 15 with the exponential formula', () => {
    const mine = BUILDING_DEFS.mine; // { stone: 200, wood: 80 }
    const factor = (L: number) => 0.8 * (1.15 ** (L - 10));
    const expected = (L: number) => ({
      stone: Math.ceil(200 * factor(L)),
      wood: Math.ceil(80 * factor(L)),
    });
    expect(upgradeCost(mine, 11)).toEqual(expected(11));
    expect(upgradeCost(mine, 12)).toEqual(expected(12));
    expect(upgradeCost(mine, 15)).toEqual(expected(15));
    // Sanity-check the corrected fractions: floor 11 starts at 0.8×1.15 = 0.92.
    const stone11 = upgradeCost(mine, 11).stone!;
    const stone20 = upgradeCost(mine, 20).stone!;
    expect(stone11 / 200).toBeCloseTo(0.92, 2);
    expect(upgradeCost(mine, 15).stone! / 200).toBeCloseTo(1.61, 2);
    expect(stone20 / 200).toBeCloseTo(3.24, 2);
  });

  it('cost keeps growing without a cap', () => {
    const mine = BUILDING_DEFS.mine;
    const costs: number[] = [];
    for (let L = 11; L <= 100; L++) {
      costs.push(upgradeCost(mine, L).stone!);
    }
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]!).toBeGreaterThanOrEqual(costs[i - 1]!);
    }
    expect(costs[costs.length - 1]!).toBeGreaterThan(costs[0]!);
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
  it('allows upgrading past floor 9 with no hard cap', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, floorLevel: 9 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(10);
  });

  it('deducts the exponential cost when upgrading into floor 11', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 10000;
    state.inventory.wood = 10000;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, floorLevel: 9 };
    spec.buildings.push(b);
    const before = { ...state.inventory };
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(10);
    const expectedCost = upgradeCost(BUILDING_DEFS.mine, 11);
    expect(before.stone - state.inventory.stone).toBe(expectedCost.stone!);
    expect(before.wood - state.inventory.wood).toBe(expectedCost.wood!);
  });

  it('rejects with not-found when the buildingId is absent', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const r = applyUpgrade(spec, state, 'no-such-id');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-found');
  });

  it('enqueues a build job when the target building is itself already under construction (#31)', () => {
    // New stacking contract (#31): a busy building no longer hard-rejects — the
    // upgrade queues as a BuildJob in state.buildJobs and the running build
    // keeps ticking. The queued upgrade does NOT pre-bump the running build's
    // floorLevel; that happens when it promotes to running.
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, constructionRemainingMs: 5000 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(countQueuedUpgrades(state, 'b1')).toBe(1);
    expect(b.floorLevel).toBeUndefined(); // running build's floor not pre-bumped by the queued job
  });

  it('enqueues a BuildJob when the running cap is taken but queue has room (#31)', () => {
    // Contract (#31): running slots full + queue room → enqueue as a BuildJob,
    // not reject. The queued upgrade lives in state.buildJobs and does NOT
    // pre-bump the target's floorLevel or set b.queued.
    const spec = makeSpec();
    const state = makeState(spec);
    // One OTHER building occupies the island's single (no-skill) build slot.
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });
    const target: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(target);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(countQueuedUpgrades(state, 'b1')).toBe(1);
    // floorLevel NOT advanced for a queued upgrade.
    expect(target.floorLevel).toBeUndefined();
    // queued flag is NOT set on the building (the job, not the building, carries the queue state).
    expect(target.queued).toBeUndefined();
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

  it('stores constructionTotalMs equal to constructionRemainingMs on an upgrade', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.constructionTotalMs).toBe(b.constructionRemainingMs);
  });

  it('does NOT credit the storage delta at upgrade commit for a generic Crate (deferred)', () => {
    // §storage-timing: the +500 per-level delta is granted at construction
    // COMPLETION of the upgrade, not at commit. (Was: immediate +500 here.)
    // After applyUpgrade the building is under construction and caps are
    // unchanged from before the upgrade. (Completion crediting is verified
    // against advanceIsland in economy.test.ts.)
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'crate', x: 0, y: 0, cargoLabel: 'copper_ore' };
    spec.buildings.push(b);
    // Seed the L0 cap contribution the operational crate already holds.
    const beforeCopper = (state.storageCaps.copper_ore ?? 0) + 500;
    state.storageCaps.copper_ore = beforeCopper;
    const beforeIron = state.storageCaps.iron_ore ?? 0;
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(1);
    expect((b.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    // No delta credited at commit.
    expect(state.storageCaps.copper_ore).toBe(beforeCopper);
    expect(state.storageCaps.iron_ore).toBe(beforeIron);
  });

  it('does NOT credit the storage delta at upgrade commit for a specialized Silo (deferred)', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const b: PlacedBuilding = { id: 'b1', defId: 'silo', x: 0, y: 0 };
    spec.buildings.push(b);
    // Seed the L0 cap contribution across dry_goods.
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
    expect(b.floorLevel).toBe(1);
    expect((b.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    // No dry_goods delta credited at commit — caps unchanged.
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      if (RESOURCE_STORAGE_CATEGORY[r] === 'dry_goods') {
        expect(state.storageCaps[r]).toBe(beforeDry[r] ?? 0);
      }
    }
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

  it('spends one self_replication_module to waive material cost and still enqueues the build', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    state.inventory.self_replication_module = 3;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const r = applyUpgrade(spec, state, 'b1', true);
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(1);
    expect(state.inventory.self_replication_module).toBe(2);
    expect(state.inventory.stone).toBe(0);
    expect(state.inventory.wood).toBe(0);
    expect((b.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
  });

  it('falls back to material payment when spendToken=true but no module is on hand', () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.stone = 300;
    state.inventory.wood = 200;
    state.inventory.self_replication_module = 0;
    const b: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(b);
    const before = { ...state.inventory };
    const r = applyUpgrade(spec, state, 'b1', true);
    expect(r.ok).toBe(true);
    expect(b.floorLevel).toBe(1);
    expect(state.inventory.self_replication_module).toBe(0);
    expect(state.inventory.stone).toBe(before.stone! - 160);
    expect(state.inventory.wood).toBe(before.wood! - 64);
  });
});

// ---------------------------------------------------------------------------
// applyUpgrade stacking (#31)
// ---------------------------------------------------------------------------
describe('applyUpgrade stacking (#31)', () => {
  // A mine at floorLevel 8, idle, with generous inventory for several upgrades.
  // Starting near floor 10 makes successive ascending targets cross the §4.9
  // exponential curve so per-upgrade cost baskets differ.
  function makeStackScene(floorLevel = 8): { spec: IslandSpec; state: IslandState; target: PlacedBuilding } {
    const spec = makeSpec();
    const state = makeState(spec);
    const target: PlacedBuilding = { id: 'b1', defId: 'mine', x: 0, y: 0, floorLevel };
    spec.buildings.push(target);
    return { spec, state, target };
  }

  it('1) first upgrade on an idle building with a free slot starts RUNNING', () => {
    const { spec, state, target } = makeStackScene();
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect((target.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    expect(target.floorLevel).toBe(9); // raw bumped by the running upgrade
    expect(countQueuedUpgrades(state, 'b1')).toBe(0);
  });

  it('2) a second upgrade while running returns ok:true and queues one job', () => {
    const { spec, state } = makeStackScene();
    const r1 = applyUpgrade(spec, state, 'b1');
    expect(r1.ok).toBe(true);
    const r2 = applyUpgrade(spec, state, 'b1');
    expect(r2.ok).toBe(true);
    // Not the old already-building rejection.
    expect((r2 as { reason?: string }).reason).toBeUndefined();
    expect(countQueuedUpgrades(state, 'b1')).toBe(1);
  });

  it('3) a third upgrade stacks to two queued; per-building job seqs strictly increase', () => {
    const { spec, state } = makeStackScene();
    applyUpgrade(spec, state, 'b1'); // running
    const r2 = applyUpgrade(spec, state, 'b1'); // queued #1
    const r3 = applyUpgrade(spec, state, 'b1'); // queued #2
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(countQueuedUpgrades(state, 'b1')).toBe(2);
    const seqs = (state.buildJobs ?? []).filter((j) => j.buildingId === 'b1').map((j) => j.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
  });

  it('4) each enqueue charges upgradeCost for its ascending displayed target', () => {
    const { spec, state } = makeStackScene();
    // Expected ascending displayed targets: running=10, queued1=11, queued2=12.
    const c10 = upgradeCost(BUILDING_DEFS.mine, 10);
    const c11 = upgradeCost(BUILDING_DEFS.mine, 11);
    const c12 = upgradeCost(BUILDING_DEFS.mine, 12);
    // Costs differ per ascending target (exponential past floor 10).
    expect(c11.stone).not.toBe(c10.stone);
    expect(c12.stone).not.toBe(c11.stone);

    const stone0 = state.inventory.stone;
    const wood0 = state.inventory.wood;
    applyUpgrade(spec, state, 'b1'); // charges c10
    applyUpgrade(spec, state, 'b1'); // charges c11
    applyUpgrade(spec, state, 'b1'); // charges c12
    const totalStone = (c10.stone ?? 0) + (c11.stone ?? 0) + (c12.stone ?? 0);
    const totalWood = (c10.wood ?? 0) + (c11.wood ?? 0) + (c12.wood ?? 0);
    expect(stone0 - state.inventory.stone).toBe(totalStone);
    expect(wood0 - state.inventory.wood).toBe(totalWood);
  });

  it('5) returns queue-full once running + every queued slot is taken', () => {
    const { spec, state } = makeStackScene();
    applyUpgrade(spec, state, 'b1'); // running (1)
    const qSlots = queuedBuildSlots(state);
    for (let i = 0; i < qSlots; i++) {
      const r = applyUpgrade(spec, state, 'b1');
      expect(r.ok).toBe(true);
    }
    expect(countQueuedUpgrades(state, 'b1')).toBe(qSlots);
    const overflow = applyUpgrade(spec, state, 'b1');
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.reason).toBe('queue-full');
  });

  it('6) returns insufficient-resources with a missing basket when inventory is short', () => {
    const { spec, state } = makeStackScene(0);
    state.inventory.stone = 0;
    state.inventory.wood = 0;
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'insufficient-resources') {
      expect(r.missing).toEqual({ stone: 160, wood: 64 });
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(r)}`);
    }
  });

  describe('promoteQueuedBuilds with upgrade jobs (#31)', () => {
    // A building at floor 1 with a RUNNING first upgrade (timer armed, raw floor
    // still 1) and one QUEUED upgrade job behind it. With a single parallel
    // build slot, the queued upgrade must wait until the running one frees the
    // building — upgrades on one building serialise.
    function makeRunningPlusQueued(): { state: IslandState; b: PlacedBuilding } {
      const { state, target } = makeStackScene(1);
      // Arm a running first upgrade WITHOUT pre-bumping the floor: the building
      // is at floor 1 and constructing toward floor 2.
      target.constructionRemainingMs = 5000;
      target.constructionTotalMs = 5000;
      // Queue one upgrade job behind it.
      state.buildJobs = [{ seq: 0, buildingId: 'b1', kind: 'upgrade' }];
      return { state, b: target };
    }

    it('(a) one slot: running building keeps the queued upgrade waiting', () => {
      const { state, b } = makeRunningPlusQueued();
      // The default scene has one parallel build slot (base 1, no Robotics
      // bonus), saturated by the running upgrade — and the building is busy.
      // Both gates keep the queued job parked.
      expect(countQueuedUpgrades(state, 'b1')).toBe(1);
      promoteQueuedBuilds(state);
      expect(countQueuedUpgrades(state, 'b1')).toBe(1);
      expect(rawFloorLevel(b)).toBe(1);
    });

    it('(b) clearing the running timer lets the queued upgrade promote', () => {
      const { state, b } = makeRunningPlusQueued();
      b.constructionRemainingMs = 0;
      promoteQueuedBuilds(state);
      expect(countQueuedUpgrades(state, 'b1')).toBe(0);
      expect(rawFloorLevel(b)).toBe(2);
      expect(b.constructionRemainingMs ?? 0).toBeGreaterThan(0);
    });
  });

  describe('cancel/demolish with queued upgrades (#31)', () => {
    it('1) LIFO cancel removes the newest queued upgrade, leaving the running build untouched', () => {
      const { spec, state } = makeStackScene();
      applyUpgrade(spec, state, 'b1'); // running (displayed target 10)
      applyUpgrade(spec, state, 'b1'); // queued #1 (displayed target 11)
      expect(countQueuedUpgrades(state, 'b1')).toBe(1);
      const b = spec.buildings.find((x) => x.id === 'b1')!;
      const runningRemaining = b.constructionRemainingMs ?? 0;
      expect(runningRemaining).toBeGreaterThan(0);

      // The queued upgrade's displayed target is 11.
      const c11 = upgradeCost(BUILDING_DEFS.mine, 11);
      // Drop inventory below cap so the refund has headroom (creditRefund
      // clamps to storageCaps); raise caps so the full basket fits.
      state.storageCaps.stone = 100000;
      state.storageCaps.wood = 100000;
      state.inventory.stone = 0;
      state.inventory.wood = 0;
      const stone0 = state.inventory.stone;
      const wood0 = state.inventory.wood;

      const r = cancelConstruction(spec, state, 'b1');
      expect(r.ok).toBe(true);
      // Newest queued removed; running job untouched.
      expect(countQueuedUpgrades(state, 'b1')).toBe(0);
      expect(b.constructionRemainingMs ?? 0).toBe(runningRemaining);
      // Refunded the queued upgrade's displayed-target cost.
      expect(state.inventory.stone - stone0).toBe(c11.stone ?? 0);
      expect(state.inventory.wood - wood0).toBe(c11.wood ?? 0);
    });

    it('2) running job is only cancelled after the queue is empty', () => {
      const { spec, state } = makeStackScene();
      applyUpgrade(spec, state, 'b1'); // running
      applyUpgrade(spec, state, 'b1'); // queued #1
      applyUpgrade(spec, state, 'b1'); // queued #2
      expect(countQueuedUpgrades(state, 'b1')).toBe(2);
      const b = spec.buildings.find((x) => x.id === 'b1')!;

      // First two cancels drain the queue without touching the running job.
      cancelConstruction(spec, state, 'b1');
      cancelConstruction(spec, state, 'b1');
      expect(countQueuedUpgrades(state, 'b1')).toBe(0);
      expect(b.constructionRemainingMs ?? 0).toBeGreaterThan(0);

      // Third cancel now reverts the running upgrade.
      const r = cancelConstruction(spec, state, 'b1');
      expect(r.ok).toBe(true);
      expect(b.constructionRemainingMs ?? 0).toBe(0);
    });

    it('3) demolish purges any orphan queued upgrade jobs for the removed building', () => {
      const { spec, state } = makeStackScene();
      // Mark the building completed so demolish accepts it.
      const b = spec.buildings.find((x) => x.id === 'b1')!;
      b.constructionRemainingMs = 0;
      state.buildJobs = [
        { seq: 0, buildingId: 'b1', kind: 'upgrade' },
        { seq: 1, buildingId: 'other', kind: 'upgrade' },
      ];
      demolishBuilding(spec, state, 'b1');
      expect(countQueuedUpgrades(state, 'b1')).toBe(0);
      // Unrelated building's jobs survive.
      expect(countQueuedUpgrades(state, 'other')).toBe(1);
    });
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
    const m1 = { id: 'm1', defId: 'mine', x: 0, y: 0, constructionRemainingMs: 5000, disabledFloors: 1 } as PlacedBuilding;
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
    expect(m1.disabledFloors).toBe(1);
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

  it('applyUpgrade enqueues a BuildJob (no floorLevel/queued mutation) when running slots full and queue has room (#31)', () => {
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
    expect(countQueuedUpgrades(state, 'b1')).toBe(1);
    // floorLevel NOT advanced for a queued upgrade.
    expect(target.floorLevel).toBeUndefined();
    // queued flag is NOT set on the building.
    expect(target.queued).toBeUndefined();
  });

  it('applyUpgrade STACKS a second upgrade onto an already-running target instead of rejecting (#31)', () => {
    // New stacking contract (#31): a building already under construction no
    // longer hard-rejects a second upgrade — it queues. (Old behaviour was
    // reason: 'already-building'.)
    const spec = makeSpec();
    const state = makeState(spec);
    // A building that is already building (running upgrade in flight). Its
    // floorLevel is pre-bumped to the running upgrade's target.
    const target: PlacedBuilding = {
      id: 'b1',
      defId: 'mine',
      x: 0,
      y: 0,
      floorLevel: 1,
      constructionRemainingMs: 5000,
      constructionTotalMs: 5000,
    };
    spec.buildings.push(target);
    const floorBefore = target.floorLevel;
    const r = applyUpgrade(spec, state, 'b1');
    expect(r.ok).toBe(true);
    expect(countQueuedUpgrades(state, 'b1')).toBe(1);
    // The running build's floorLevel is NOT touched by the queued job.
    expect(target.floorLevel).toBe(floorBefore);
  });
});

// ---------------------------------------------------------------------------
// cancelConstruction — 100% refund for in-progress builds and upgrades
// ---------------------------------------------------------------------------
describe('cancelConstruction full refund', () => {
  it('cancel fresh in-progress placement → building removed + 100% refund', () => {
    // Mine costs stone:200 + wood:80. Place it (goes under construction),
    // then cancel — inventory must be fully restored and building removed.
    // Use large caps and controlled starting inventory to avoid clamp surprises.
    const spec = makeSpec();
    const state = makeState(spec);
    state.storageCaps.stone = 50000;
    state.storageCaps.wood = 50000;
    state.inventory.stone = 1000;
    state.inventory.wood = 500;

    const stoneBefore = state.inventory.stone;
    const woodBefore = state.inventory.wood;

    const r = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'cancel-fresh-1');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    const b = r.placed;
    // Must be under construction (not instantBuild).
    expect((b.constructionRemainingMs ?? 0)).toBeGreaterThan(0);
    expect(b.floorLevel ?? 0).toBe(0);

    const cr = cancelConstruction(spec, state, b.id);
    expect(cr.ok).toBe(true);
    // Building is gone.
    expect(spec.buildings.find((x) => x.id === b.id)).toBeUndefined();
    // Inventory fully restored — 100% refund.
    expect(state.inventory.stone).toBe(stoneBefore);
    expect(state.inventory.wood).toBe(woodBefore);
  });

  it('cancel in-progress upgrade → level reverted, timer cleared, queued cleared, upgrade cost refunded', () => {
    // Start from an operational mine at floorLevel 0 (no constructionRemainingMs),
    // applyUpgrade to level 1 (deducts upgradeCost, sets constructionRemainingMs),
    // then cancel — upgrade cost must be fully refunded and building kept.
    const spec = makeSpec();
    const state = makeState(spec);
    state.storageCaps.stone = 50000;
    state.storageCaps.wood = 50000;
    state.inventory.stone = 1000;
    state.inventory.wood = 500;

    // Plant a pre-built operational mine (floorLevel 0, no constructionRemainingMs).
    const target: PlacedBuilding = { id: 'upg-mine', defId: 'mine', x: 0, y: 0 };
    spec.buildings.push(target);

    // Record inventory before upgrade.
    const stoneBefore = state.inventory.stone;
    const woodBefore = state.inventory.wood;

    const ur = applyUpgrade(spec, state, 'upg-mine');
    expect(ur.ok).toBe(true);
    // Now at floorLevel 1, constructionRemainingMs > 0.
    expect(target.floorLevel).toBe(1);
    expect((target.constructionRemainingMs ?? 0)).toBeGreaterThan(0);

    const cr = cancelConstruction(spec, state, 'upg-mine');
    expect(cr.ok).toBe(true);
    // Building persists.
    expect(spec.buildings.find((x) => x.id === 'upg-mine')).toBeDefined();
    // Level reverted to 0.
    expect(target.floorLevel ?? 0).toBe(0);
    // Timer cleared.
    expect(target.constructionRemainingMs ?? 0).toBe(0);
    // queued cleared.
    expect(target.queued).toBeFalsy();
    // Inventory fully restored to pre-upgrade values — 100% refund.
    expect(state.inventory.stone).toBe(stoneBefore);
    expect(state.inventory.wood).toBe(woodBefore);
  });

  it('cancel unfinished fresh storage placement → caps unchanged (nothing to strip)', () => {
    // §storage-timing: a fresh Crate under construction never received its
    // +500 cap (credit is deferred to completion), so cancelling it leaves
    // storageCaps exactly as they were before placement. Materials refunded.
    const spec = makeSpec();
    const state = makeState(spec);
    state.storageCaps.wood = 50000;
    state.storageCaps.stone = 50000;
    state.inventory.wood = 1000;
    state.inventory.stone = 1000;
    const capsBefore = { ...state.storageCaps };
    const woodBefore = state.inventory.wood;
    const stoneBefore = state.inventory.stone;

    const r = placeBuilding(spec, state, 'crate', 0, 0, 0, () => 'cancel-crate');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    // No cap was granted at placement.
    for (const res of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[res]).toBe(capsBefore[res]);
    }

    const cr = cancelConstruction(spec, state, r.placed.id);
    expect(cr.ok).toBe(true);
    // Building removed.
    expect(spec.buildings.find((x) => x.id === r.placed.id)).toBeUndefined();
    // Materials fully refunded.
    expect(state.inventory.wood).toBe(woodBefore);
    expect(state.inventory.stone).toBe(stoneBefore);
    // Caps untouched — nothing was ever granted, so nothing is stripped.
    for (const res of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[res]).toBe(capsBefore[res]);
    }
  });

  it('cancel unfinished storage upgrade → level reverted, caps unchanged', () => {
    // §storage-timing: the upgrade's +500 delta is deferred to completion, so
    // an in-progress upgrade holds no extra cap; cancelling reverts the level
    // and refunds the upgrade cost without touching storageCaps.
    const spec = makeSpec();
    spec.buildings.push({ id: 'c1', defId: 'crate', x: 0, y: 0, cargoLabel: 'iron_ore' });
    const state = makeInitialIslandState(spec, 0);
    state.level = 10;
    // Raise wood/stone caps so the refund isn't clamped (default dry_goods
    // cap is 100, below our seeded inventory).
    state.storageCaps.wood = 50000;
    state.storageCaps.stone = 50000;
    state.inventory.wood = 1000;
    state.inventory.stone = 1000;
    const capsBefore = { ...state.storageCaps }; // includes operational L0 +500
    const woodBefore = state.inventory.wood;
    const stoneBefore = state.inventory.stone;

    const ur = applyUpgrade(spec, state, 'c1');
    expect(ur.ok).toBe(true);
    expect(spec.buildings[0]!.floorLevel).toBe(1);
    // No delta credited while upgrading.
    expect(state.storageCaps.iron_ore).toBe(capsBefore.iron_ore);

    const cr = cancelConstruction(spec, state, 'c1');
    expect(cr.ok).toBe(true);
    expect(spec.buildings[0]!.floorLevel ?? 0).toBe(0);
    expect((spec.buildings[0]!.constructionRemainingMs ?? 0)).toBe(0);
    // Upgrade cost refunded.
    expect(state.inventory.wood).toBe(woodBefore);
    expect(state.inventory.stone).toBe(stoneBefore);
    // Caps unchanged — the L0 base cap stays, no delta was ever added/stripped.
    for (const res of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      expect(state.storageCaps[res]).toBe(capsBefore[res]);
    }
  });

  it('cancel a queued placement → building removed, queue count decreases', () => {
    // Occupy the running slot, then enqueue a placement. Cancel the queued build.
    const spec = makeSpec();
    const state = makeState(spec);
    state.storageCaps.stone = 50000;
    state.storageCaps.wood = 50000;
    spec.buildings.push({ id: 'busy', defId: 'mine', x: 5, y: 5, constructionRemainingMs: 5000 });

    const before = queuedBuildCount(state);
    const r = placeBuilding(spec, state, 'mine', 0, 0, 0, () => 'q-cancel');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.placed.queued).toBe(true);
    expect(queuedBuildCount(state)).toBe(before + 1);

    const cr = cancelConstruction(spec, state, r.placed.id);
    expect(cr.ok).toBe(true);
    expect(spec.buildings.find((x) => x.id === r.placed.id)).toBeUndefined();
    expect(queuedBuildCount(state)).toBe(before);
  });

  it('cancel a finished/operational building → rejected with not-building', () => {
    // A building with no constructionRemainingMs is operational — cancel must reject.
    const spec = makeSpec();
    const state = makeState(spec);
    spec.buildings.push({ id: 'done', defId: 'mine', x: 0, y: 0 });

    const cr = cancelConstruction(spec, state, 'done');
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.reason).toBe('not-building');
  });

  it('cancel unknown id → rejected with not-found', () => {
    const spec = makeSpec();
    const state = makeState(spec);

    const cr = cancelConstruction(spec, state, 'no-such-id');
    expect(cr.ok).toBe(false);
    if (!cr.ok) expect(cr.reason).toBe('not-found');
  });
});

// ---------------------------------------------------------------------------
// §4.6 relabel storage cap: applyRelabelStorageCap construction guard
// ---------------------------------------------------------------------------
// Regression tests for the bug where relabeling a STILL-UNDER-CONSTRUCTION
// generic-storage building (Crate/Warehouse) would:
//   1. Strip a base cap that was never granted from the old label (iron_ore 100 → 0).
//   2. Add a phantom cap to the new label, then creditStorageCaps at completion
//      doubled it (copper 1000 instead of 500).
//
// The fix: applyRelabelStorageCap skips all cap arithmetic when the building is
// under construction or queued, returning 'label-only'. Completion credits the
// CURRENT cargoLabel — so changing the label during construction produces the
// correct result without any double-credit.
// ---------------------------------------------------------------------------
describe('applyRelabelStorageCap — construction guard', () => {
  const CRATE_DEF = BUILDING_DEFS['crate']!;
  const CRATE_MULT = CRATE_DEF.storage!.capacity; // 5 (percentage multiplier)
  // §4.6 percentage model: copper_ore base 100 → contribution = mult × 100 = 500.
  const BASE_CAP = 500;

  // Helper: minimal IslandState for relabel tests.
  function relabelState(
    overrides: Partial<Record<ResourceId, number>> = {},
  ): { state: ReturnType<typeof makeState>; building: PlacedBuilding } {
    const spec = makeSpec();
    const st = makeState(spec);
    // Zero all storageCaps to make assertions unambiguous.
    for (const r of ALL_RESOURCES as ReadonlyArray<ResourceId>) {
      st.storageCaps[r] = 0;
    }
    for (const [r, v] of Object.entries(overrides) as [ResourceId, number][]) {
      st.storageCaps[r] = v;
    }
    const building: PlacedBuilding = {
      id: 'test-crate',
      defId: 'crate',
      x: 0,
      y: 0,
      cargoLabel: 'iron_ore',
    };
    return { state: st, building };
  }

  it('UNDER CONSTRUCTION → no cap arithmetic; completion credits NEW label once (no double-credit)', () => {
    // The pre-fix code would FAIL here: relabeling an under-construction Crate
    // strips iron_ore cap (never granted) and adds phantom copper cap, then
    // creditStorageCaps at completion doubles it to 1000.
    const { state, building } = relabelState({ iron_ore: 0, copper_ore: 0 });

    // Mark as under construction (30s remaining).
    (building as { constructionRemainingMs?: number }).constructionRemainingMs = 30_000;

    const result = applyRelabelStorageCap(state, building, CRATE_DEF, 'iron_ore', 'copper_ore');

    // Must return 'label-only' — cap arithmetic skipped.
    expect(result).toBe('label-only');
    // iron_ore cap: was 0, must remain 0 (was never granted — nothing to strip).
    expect(state.storageCaps.iron_ore).toBe(0);
    // copper_ore cap: was 0, must remain 0 (phantom add would have set it to 500).
    expect(state.storageCaps.copper_ore).toBe(0);

    // Caller then sets building.cargoLabel to the new label (as applyRelabel does).
    building.cargoLabel = 'copper_ore';

    // Simulate construction completion crediting (mirrors economy.ts logic exactly).
    // floorLevel(building) = 0 → fresh placement → credit the multiplier.
    creditStorageCaps(state, building, CRATE_DEF, CRATE_MULT);

    // copper_ore cap must be exactly BASE_CAP (500), NOT doubled (1000).
    expect(state.storageCaps.copper_ore).toBe(BASE_CAP);
    // iron_ore cap unchanged (completion credits copper only, as the label dictates).
    expect(state.storageCaps.iron_ore).toBe(0);
  });

  it('QUEUED → no cap arithmetic; label-only result', () => {
    const { state, building } = relabelState({ iron_ore: 0, copper_ore: 0 });

    (building as { queued?: boolean; constructionRemainingMs?: number }).queued = true;
    (building as { constructionRemainingMs?: number }).constructionRemainingMs = 30_000;

    const result = applyRelabelStorageCap(state, building, CRATE_DEF, 'iron_ore', 'copper_ore');

    expect(result).toBe('label-only');
    expect(state.storageCaps.iron_ore).toBe(0);
    expect(state.storageCaps.copper_ore).toBe(0);
  });

  it('OPERATIONAL (construction complete, not queued) → cap moves from old to new label', () => {
    // Unchanged existing behaviour: a completed Crate has its iron_ore cap
    // already credited (= BASE_CAP). Relabeling to copper_ore must move it.
    const { state, building } = relabelState({ iron_ore: BASE_CAP, copper_ore: 0 });

    // Building is complete: constructionRemainingMs absent / 0.
    // (building has no constructionRemainingMs field, defaulting to 0)

    const result = applyRelabelStorageCap(state, building, CRATE_DEF, 'iron_ore', 'copper_ore');

    expect(result).toBe('moved');
    // iron_ore cap reduced by BASE_CAP.
    expect(state.storageCaps.iron_ore).toBe(0);
    // copper_ore cap increased by BASE_CAP.
    expect(state.storageCaps.copper_ore).toBe(BASE_CAP);
  });

  it('fully-active operational building → cap moves on relabel', () => {
    // applyRelabelStorageCap's guard keys off construction-complete + not-queued
    // only; an operational (fully-active) building has its cap credited and a
    // relabel moves the full BASE_CAP. (Floor-disable is no longer a no-op for
    // caps — setBuildingActiveFloors adjusts storageCaps directly — so the cap
    // a relabel moves is whatever the building's current ACTIVE floors credited.)
    const { state, building } = relabelState({ iron_ore: BASE_CAP, copper_ore: 0 });

    // No disabledFloors, no constructionRemainingMs → fully active, complete.

    const result = applyRelabelStorageCap(state, building, CRATE_DEF, 'iron_ore', 'copper_ore');

    expect(result).toBe('moved');
    expect(state.storageCaps.iron_ore).toBe(0);
    expect(state.storageCaps.copper_ore).toBe(BASE_CAP);
  });
});

describe('queued-upgrade helpers (#31)', () => {
  it('countQueuedUpgrades counts only this building’s jobs', () => {
    const state = { buildJobs: [
      { seq: 1, buildingId: 'a', kind: 'upgrade' as const },
      { seq: 2, buildingId: 'b', kind: 'upgrade' as const },
      { seq: 3, buildingId: 'a', kind: 'upgrade' as const },
    ] } as unknown as import('./economy.js').IslandState;
    expect(countQueuedUpgrades(state, 'a')).toBe(2);
    expect(countQueuedUpgrades(state, 'b')).toBe(1);
    expect(countQueuedUpgrades(state, 'c')).toBe(0);
  });

  it('countQueuedUpgrades handles missing buildJobs', () => {
    const state = {} as unknown as import('./economy.js').IslandState;
    expect(countQueuedUpgrades(state, 'a')).toBe(0);
  });

  it('topUpgradeLevel = rawFloorLevel + queued upgrade count', () => {
    const state = { buildJobs: [
      { seq: 1, buildingId: 'a', kind: 'upgrade' as const },
      { seq: 3, buildingId: 'a', kind: 'upgrade' as const },
    ] } as unknown as import('./economy.js').IslandState;
    expect(topUpgradeLevel(state, { id: 'a', floorLevel: 1 })).toBe(3);
    expect(topUpgradeLevel(state, { id: 'z', floorLevel: 0 })).toBe(0);
  });
});

describe('setBuildingActiveFloors (floor-disable)', () => {
  // A labeled crate at floorLevel 1 (2 built floors) whose cap is already
  // aggregated into state.storageCaps and whose inventory is filled to that cap.
  function makeStorageScene(): { spec: IslandSpec; state: IslandState; res: ResourceId } {
    const res: ResourceId = 'iron_ore';
    const spec = makeSpec({
      buildings: [{ id: 'c-iron', defId: 'crate', x: 0, y: 0, cargoLabel: res, floorLevel: 1 }],
    });
    const state = makeState(spec);
    state.inventory[res] = state.storageCaps[res]!;
    return { spec, state, res };
  }

  it('lowers a storage building’s cap and clamps overflow', () => {
    const { spec, state, res } = makeStorageScene();
    const id = spec.buildings[0]!.id;
    const capBefore = state.storageCaps[res]!;
    setBuildingActiveFloors(spec, state, id, 2); // disable both floors -> active 0
    expect(activeFloors(spec.buildings[0]!)).toBe(0);
    expect(state.storageCaps[res]!).toBeLessThan(capBefore);
    expect(state.inventory[res]!).toBeLessThanOrEqual(state.storageCaps[res]!); // overflow clamped
  });

  it('toggling back up restores the cap contribution', () => {
    const { spec, state, res } = makeStorageScene();
    const id = spec.buildings[0]!.id;
    const full = state.storageCaps[res]!;
    setBuildingActiveFloors(spec, state, id, 2); // off
    setBuildingActiveFloors(spec, state, id, 0); // full active again
    expect(state.storageCaps[res]!).toBeCloseTo(full, 6);
  });

  it('returns not-found for an unknown building id', () => {
    const { spec, state } = makeStorageScene();
    expect(setBuildingActiveFloors(spec, state, 'nope', 1)).toEqual({ ok: false, reason: 'not-found' });
  });
});
