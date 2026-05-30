// Targeted unit test for the §4.6 placement-UI picker-cancel path.
//
// AGENTS.md says "tests target the pure layer only" and placement-ui.ts
// imports PixiJS for the preview-layer Container/Graphics/Text. Those are
// plain JS classes — they construct fine in node (WebGL is only needed at
// render time, and these tests never call `app.render`). The only purpose
// here is to assert the cancel-from-picker contract: when `pickCargoLabel`
// resolves null, `begin()` exits cleanly without arming placement and
// without ever invoking `placeBuilding` (so `spec.buildings` stays empty).
//
// If a future Pixi version moves browser-globals to module-init time this
// file should be the first casualty — drop it and rely on the placement.ts
// pure-layer tests for the rest of the §4.6 contract.

import { describe, expect, it } from 'vitest';

import { mountPlacementUi } from './placement-ui.js';
import { makeInitialIslandState } from './world.js';
import type { IslandSpec, WorldState } from './world.js';
import type { IslandState } from './economy.js';
import { CELL_SIZE_TILES } from './constants.js';
import type { OceanCellSpec } from './ocean-cell.js';

function makeSpec(): IslandSpec {
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
  };
}

function makeState(spec: IslandSpec): IslandState {
  const s = makeInitialIslandState(spec, 0);
  s.level = 5;
  s.inventory.stone = 10000;
  s.inventory.wood = 10000;
  s.inventory.steel_beam = 10000;
  s.inventory.concrete = 10000;
  s.inventory.gear = 10000;
  s.inventory.pipe = 10000;
  s.inventory.microchip = 10000;
  return s;
}

describe('§4.6 placement-ui cancel-from-picker', () => {
  it('does not place a building when the picker resolves null', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    let placedCalled = 0;
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {
        placedCalled++;
      },
      // Cancel: picker resolves null → placement must abort entirely.
      pickCargoLabel: () => Promise.resolve(null),
    });
    ui.begin('crate');
    // Flush microtasks so the picker promise resolves before assertions.
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.isActive()).toBe(false);
    expect(spec.buildings).toHaveLength(0);
    expect(placedCalled).toBe(0);
    // Even an explicit commit attempt after cancel must no-op (no active
    // session to commit, no building added).
    const r = ui.attemptCommit();
    expect(r.ok).toBe(false);
    expect(spec.buildings).toHaveLength(0);
  });

  it('arms placement and threads the chosen label through when the picker resolves a ResourceId', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      // Identity transform — attemptCommit() reads cursorScreenX/Y (both 0
      // at construction) and runs screenToWorldTile(0,0) → tile (0,0),
      // which is the island center, inside r=14. We deliberately skip
      // setCursorScreenPos because that path triggers Pixi Text bounds
      // measurement (CanvasTextMetrics) and node-Pixi has no canvas.
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      pickCargoLabel: () => Promise.resolve('copper_ore'),
    });
    ui.begin('crate');
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.isActive()).toBe(true);
    const r = ui.attemptCommit();
    expect(r.ok).toBe(true);
    expect(spec.buildings).toHaveLength(1);
    expect(spec.buildings[0]!.cargoLabel).toBe('copper_ore');
  });

  it('bypasses the picker for non-generic-storage defs (Mine arms immediately)', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    let pickerInvoked = 0;
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      pickCargoLabel: () => {
        pickerInvoked++;
        return Promise.resolve(null);
      },
    });
    ui.begin('mine');
    // Non-generic defs arm synchronously — no await needed for isActive.
    expect(ui.isActive()).toBe(true);
    expect(pickerInvoked).toBe(0);
  });
});

// §4 ocean-layer placement-UI ocean branch integration.
//
// These tests pin the contract: ocean defs route through
// `validateOceanPlacement` + the anchor-picker, the picker resolves the anchor
// island, `placeBuilding` is called with that anchorIslandId, and validator
// rejections surface via `oceanReason` (parallel field — `OceanPlacementReason`
// is intentionally disjoint from `PlacementReason`, per the type comment in
// placement.ts).
//
// Same node-Pixi caveat as the cargo-label tests above: avoid
// `setCursorScreenPos` (triggers CanvasTextMetrics). Use the default cursor
// at screen (0, 0) and an identity `screenToWorldTile` so the active cursor
// resolves to cell (0, 0) — anchor island sits 5 cells away so it's in range
// without overlapping the cell-(0,0) footprint.

/** Build an `IslandSpec` for use as an anchor candidate. Positioned far
 *  enough from cell (0, 0) that its r=14 ellipse cannot overlap the 2×2
 *  cell footprint (which covers tiles [0..31] × [0..31]). 5 cells away in
 *  +x → tile (80, 0), inside ANCHOR_MAX_RANGE_CELLS. */
function makeAnchorSpec(id: string): IslandSpec {
  return {
    id,
    name: id,
    biome: 'plains',
    cx: 5 * CELL_SIZE_TILES,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
  };
}

/** Build a `WorldState` stub with the supplied islands and ocean cells.
 *  Ocean-branch placement reads `world.islands`, `world.oceanCells`, and
 *  (via `validateOceanPlacement` → `isOceanTile`) the union of island
 *  ellipses — only those fields are populated. Mirrors the
 *  `placement.test.ts:makeOceanWorld` pattern. */
function makeOceanWorld(
  islands: IslandSpec[],
  oceanCells: Map<string, OceanCellSpec> = new Map(),
): WorldState {
  return { islands, oceanCells, recentBuildAttempts: new Set(), recentBuildAttemptTs: new Map() } as unknown as WorldState;
}

/** Stage cell (0, 0) as shallows so an `open_water_extractor` (terrainReqs:
 *  ['shallows', 'deep']) accepts the entire 2×2 footprint there. Cells not
 *  listed default to `deep` via the `terrainAt` fallback — also in the
 *  allowed set, so a partial seed suffices. */
function shallowsAtCell00(): Map<string, OceanCellSpec> {
  const m = new Map<string, OceanCellSpec>();
  m.set('0,0', { terrain: 'shallows' });
  m.set('1,0', { terrain: 'shallows' });
  m.set('0,1', { terrain: 'shallows' });
  m.set('1,1', { terrain: 'shallows' });
  return m;
}

describe('§4 placement-ui ocean branch', () => {
  it('routes ocean def through validateOceanPlacement + picker, places with anchorIslandId', async () => {
    const anchor = makeAnchorSpec('anchor-1');
    const anchorState = makeInitialIslandState(anchor, 0);
    anchorState.level = 5;
    // Seed plenty of placement-cost resources on the anchor. Open-Water
    // Extractor costs carbon_steel:80, wire:30, microchip:15 — overshoot
    // each so the §14 cost gate passes.
    anchorState.inventory.carbon_steel = 10000;
    anchorState.inventory.wire = 10000;
    anchorState.inventory.microchip = 10000;
    anchorState.inventory.steel_beam = 10000;
    anchorState.inventory.concrete = 10000;
    anchorState.inventory.gear = 10000;
    anchorState.inventory.pipe = 10000;
    // Dummy target spec/state for the land path's getTargetSpec/getTargetState
    // calls (the ocean branch never reads them, but the deps require them).
    const dummySpec = makeSpec();
    const dummyState = makeState(dummySpec);
    const world = makeOceanWorld([anchor], shallowsAtCell00());
    let placedCalled = 0;
    let pickerCandidates: Array<{ islandId: string }> = [];
    const ui = mountPlacementUi({
      getTargetSpec: () => dummySpec,
      getTargetState: () => dummyState,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {
        placedCalled++;
      },
      getWorld: () => world,
      getStateById: (id) => (id === anchor.id ? anchorState : undefined),
      pickAnchor: (cands) => {
        pickerCandidates = cands.map((c) => ({ islandId: c.islandId }));
        return Promise.resolve(anchor.id);
      },
    });
    ui.begin('open_water_extractor');
    expect(ui.isActive()).toBe(true);
    const r = ui.attemptCommit();
    // Synchronous return is {ok: false} — commit completes via the async
    // picker resolution. The actual success signal is the post-await state.
    expect(r.ok).toBe(false);
    expect(r.reason).toBeUndefined();
    expect(r.oceanReason).toBeUndefined();
    // Flush microtasks so the picker resolution + placeBuilding mutation lands.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pickerCandidates.length).toBe(1);
    expect(pickerCandidates[0]!.islandId).toBe(anchor.id);
    expect(placedCalled).toBe(1);
    expect(anchor.buildings).toHaveLength(1);
    expect(anchor.buildings[0]!.anchorIslandId).toBe(anchor.id);
    expect(anchor.buildings[0]!.defId).toBe('open_water_extractor');
    // Dummy target was never touched — ocean placement lives on the anchor.
    expect(dummySpec.buildings).toHaveLength(0);
  });

  it('aborts placement on picker cancel (null resolution)', async () => {
    const anchor = makeAnchorSpec('anchor-1');
    const anchorState = makeInitialIslandState(anchor, 0);
    anchorState.level = 5;
    anchorState.inventory.carbon_steel = 10000;
    anchorState.inventory.wire = 10000;
    anchorState.inventory.microchip = 10000;
    const dummySpec = makeSpec();
    const dummyState = makeState(dummySpec);
    const world = makeOceanWorld([anchor], shallowsAtCell00());
    let placedCalled = 0;
    const ui = mountPlacementUi({
      getTargetSpec: () => dummySpec,
      getTargetState: () => dummyState,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {
        placedCalled++;
      },
      getWorld: () => world,
      getStateById: (id) => (id === anchor.id ? anchorState : undefined),
      // Picker resolves null → cancel. Placement must abort entirely; no
      // mutation to anchor.buildings, no deduction from anchorState.inventory,
      // no onPlaced() fire.
      pickAnchor: () => Promise.resolve(null),
    });
    ui.begin('open_water_extractor');
    ui.attemptCommit();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(anchor.buildings).toHaveLength(0);
    expect(placedCalled).toBe(0);
    // After cancel, isActive must drop — the inner cancel() path matches the
    // cargo-label cancel contract.
    expect(ui.isActive()).toBe(false);
    // Anchor inventory untouched.
    expect(anchorState.inventory.carbon_steel).toBe(10000);
  });

  it('rejects ocean def commit with oceanReason=no-anchor-in-range when no populated island in range', () => {
    // No populated islands at all → candidateAnchors returns empty →
    // validator emits `no-anchor-in-range`. attemptCommit surfaces it via
    // the new `oceanReason` parallel field (Fix 4).
    const dummySpec = makeSpec();
    const dummyState = makeState(dummySpec);
    const world = makeOceanWorld([], shallowsAtCell00());
    const ui = mountPlacementUi({
      getTargetSpec: () => dummySpec,
      getTargetState: () => dummyState,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      getWorld: () => world,
      getStateById: () => undefined,
      pickAnchor: () => Promise.resolve(null),
    });
    ui.begin('open_water_extractor');
    const r = ui.attemptCommit();
    expect(r.ok).toBe(false);
    expect(r.oceanReason).toBe('no-anchor-in-range');
    // Land-reason channel stays unset for validator rejections — only the
    // headless / mis-wired-deps fallback uses `reason: 'def-is-ocean'`.
    expect(r.reason).toBeUndefined();
  });

  it('rejects ocean def commit with oceanReason=land-overlap when footprint overlaps an island', () => {
    // Anchor at cx=0, cy=0 covers cell (0, 0)'s footprint (tile (0, 0) is
    // dead-center of its r=14 ellipse). validateOceanPlacement's land-overlap
    // sampler catches this BEFORE the terrain match runs — and a 2nd
    // populated anchor further out keeps `no-anchor-in-range` from masking
    // the failure (otherwise land-overlap would compete with no-anchor).
    const overlapping: IslandSpec = {
      id: 'overlap',
      name: 'overlap',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    const dummySpec = makeSpec();
    const dummyState = makeState(dummySpec);
    const world = makeOceanWorld([overlapping], new Map());
    const ui = mountPlacementUi({
      getTargetSpec: () => dummySpec,
      getTargetState: () => dummyState,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
      getWorld: () => world,
      getStateById: (id) => (id === overlapping.id ? makeInitialIslandState(overlapping, 0) : undefined),
      pickAnchor: () => Promise.resolve(null),
    });
    ui.begin('open_water_extractor');
    const r = ui.attemptCommit();
    expect(r.ok).toBe(false);
    expect(r.oceanReason).toBe('land-overlap');
    expect(r.reason).toBeUndefined();
  });
});


describe('terrain_modifier placement-ui brush commit', () => {
  it('commits a terrain_modifier with terrainShotRemainingMs = SHOT_DURATION_MS', async () => {
    const spec = makeSpec();
    const state = makeState(spec);
    state.inventory.steel = 100;
    state.inventory.gear = 100;
    const ui = mountPlacementUi({
      getTargetSpec: () => spec,
      getTargetState: () => state,
      screenToWorldTile: (x, y) => ({ x, y }),
      onPlaced: () => {},
    });
    ui.begin('terrain_modifier');
    // Synchronously armed — terrain_modifier is not generic storage.
    expect(ui.isActive()).toBe(true);
    const r = ui.attemptCommit();
    expect(r.ok).toBe(true);
    expect(spec.buildings).toHaveLength(1);
    const placed = spec.buildings[0]!;
    expect(placed.defId).toBe('terrain_modifier');
    expect(placed.terrainShotRemainingMs).toBe(4000);
    expect(placed.terrainTarget).toBeUndefined();
  });
});
