// Tests for the §2.5 artificial-island construction pure logic.
//
// Position validity (overlap with existing islands, off-map placement) is
// intentionally NOT tested here — the pure layer takes `position` as-given
// and the UI layer enforces overlap rules via the world's island list.
// `validateConstruction` covers the validation paths it owns: founder tier,
// Platform Constructor presence, biome sanity, radius caps, and material
// availability.

import { describe, expect, it } from 'vitest';

import {
  computeConstructionCost,
  constructIsland,
  maxRadiusForFounderLevel,
  validateBuildingPlacement,
  validateConstruction,
  type ConstructionRequirements,
} from './artificial-island.js';
import { rollModifiersArtificial, type ModifierId } from './biomes.js';
import { BUILDING_DEFS, canPlaceOnIsland } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';
import { aggregateStorageCaps, type IslandSpec } from './world.js';

// ---------------------------------------------------------------------------
// Helpers — local copies of the patterns in economy.test.ts so this file is
// self-contained.
// ---------------------------------------------------------------------------

function blankInventory(): Record<ResourceId, number> {
  const inv = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) inv[r] = 0;
  return inv;
}

function blankFunnel(): Record<ResourceId, number> {
  const f = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) f[r] = 0;
  return f;
}

function makeFounderSpec(buildings: PlacedBuilding[]): IslandSpec {
  return {
    id: 'founder',
    name: 'founder',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 14,
    minorRadius: 14,
    populated: true,
    discovered: true,
    buildings,
    modifiers: [],
  };
}

function makeFounderState(
  buildings: PlacedBuilding[],
  inv: Partial<Record<ResourceId, number>> = {},
  level = 15,
): IslandState {
  const inventory = blankInventory();
  for (const [k, v] of Object.entries(inv)) {
    inventory[k as ResourceId] = v ?? 0;
  }
  return {
    id: 'founder',
    buildings,
    inventory,
    storageCaps: aggregateStorageCaps(buildings),
    xp: 0,
    level,
    unspentSkillPoints: 0,
    unlockedNodes: new Set(),
    unlockedEdges: new Set(),
    funnelPending: blankFunnel(),
    declaredAt: null,
    aiCoreCrafted: false,
    ascendantCoreCrafted: false,
    lastResetAt: null,
    timeLockBankedMin: 0,
    accelerationQueue: [],
    accelerationRemainingMin: 0,
    bankingEnabled: false,
    genesisTarget: null,
    singularityStoredWs: 0,
    starterInventoryGrace: {} as Record<ResourceId, number>,
    lastTick: 0,
  };
}

const PC_BUILDING: PlacedBuilding = {
  id: 'pc-1',
  defId: 'platform_constructor',
  x: -4,
  y: -4,
};

// ---------------------------------------------------------------------------
// computeConstructionCost
// ---------------------------------------------------------------------------

describe('computeConstructionCost', () => {
  it('returns sensible numbers for a 4×4 Plains island', () => {
    // tileCount ≈ π × 4 × 4 ≈ 50.27
    // steel = ceil(50.27 × 5) = 252; iron = ceil(50.27 × 3) = 151;
    // wood = ceil(50.27 × 10) = 503. No biome surcharge.
    const cost = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    expect(cost.steel).toBeGreaterThanOrEqual(250);
    expect(cost.steel).toBeLessThanOrEqual(260);
    expect(cost.iron_ingot).toBeGreaterThanOrEqual(150);
    expect(cost.iron_ingot).toBeLessThanOrEqual(160);
    expect(cost.wood).toBeGreaterThanOrEqual(500);
    expect(cost.wood).toBeLessThanOrEqual(510);
  });

  it('scales superlinearly: 8×8 costs ~4× a 4×4 (area ratio)', () => {
    const small = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    const big = computeConstructionCost({ biome: 'plains', majorRadius: 8, minorRadius: 8 });
    // π × 8 × 8 / (π × 4 × 4) = 4.0 exactly; allow ±0.05 for ceil rounding.
    const ratio = big.steel / small.steel;
    expect(ratio).toBeGreaterThan(3.95);
    expect(ratio).toBeLessThan(4.05);
  });

  it('volcanic biome adds a 50% surcharge', () => {
    const plains = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    const volc = computeConstructionCost({ biome: 'volcanic', majorRadius: 4, minorRadius: 4 });
    // Each material should be ~1.5× the plains cost. Ceil is applied AFTER
    // the surcharge to the (tileCount × multiplier × 1.5) product, so the
    // ratio may differ from a strict 1.5 by up to one unit in either
    // direction. Compare to the EXPECTED ratio (1.5), not the rounded
    // plains value.
    const expectedSteel = Math.ceil(Math.PI * 4 * 4 * 5 * 1.5);
    const expectedIron = Math.ceil(Math.PI * 4 * 4 * 3 * 1.5);
    const expectedWood = Math.ceil(Math.PI * 4 * 4 * 10 * 1.5);
    expect(volc.steel).toBe(expectedSteel);
    expect(volc.iron_ingot).toBe(expectedIron);
    expect(volc.wood).toBe(expectedWood);
    // And the ratio against plains is within (1.5 ± 1/plains) per material.
    expect(volc.steel / plains.steel).toBeGreaterThan(1.48);
    expect(volc.steel / plains.steel).toBeLessThan(1.52);
  });

  it('arctic biome also gets the 50% surcharge', () => {
    const plains = computeConstructionCost({ biome: 'plains', majorRadius: 5, minorRadius: 5 });
    const arctic = computeConstructionCost({ biome: 'arctic', majorRadius: 5, minorRadius: 5 });
    expect(arctic.steel).toBeGreaterThan(plains.steel);
    expect(arctic.steel / plains.steel).toBeGreaterThan(1.45);
    expect(arctic.steel / plains.steel).toBeLessThan(1.55);
  });

  it('forest / coast / desert use the base rate (no surcharge)', () => {
    const plains = computeConstructionCost({ biome: 'plains', majorRadius: 5, minorRadius: 5 });
    for (const biome of ['forest', 'coast', 'desert'] as const) {
      const c = computeConstructionCost({ biome, majorRadius: 5, minorRadius: 5 });
      expect(c.steel).toBe(plains.steel);
      expect(c.iron_ingot).toBe(plains.iron_ingot);
      expect(c.wood).toBe(plains.wood);
    }
  });

  it('oval shape (major != minor) scales by area, not by max axis', () => {
    // 8×4 has area π×32 ≈ 100.5, twice the 4×4 area of ~50.27.
    const oval = computeConstructionCost({ biome: 'plains', majorRadius: 8, minorRadius: 4 });
    const small = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    const ratio = oval.steel / small.steel;
    expect(ratio).toBeGreaterThan(1.95);
    expect(ratio).toBeLessThan(2.05);
  });
});

// ---------------------------------------------------------------------------
// validateConstruction — each failure path
// ---------------------------------------------------------------------------

describe('validateConstruction', () => {
  const okReq: ConstructionRequirements = {
    biome: 'plains',
    majorRadius: 4,
    minorRadius: 4,
  };

  it('rejects when founder is below T3 (level < 15)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 }, /* level */ 14);
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('tier-too-low');
  });

  it('rejects when founder has no Platform Constructor', () => {
    const spec = makeFounderSpec([
      { id: 'no-pc', defId: 'mine', x: 0, y: 0 },
    ]);
    const state = makeFounderState(
      [{ id: 'no-pc', defId: 'mine', x: 0, y: 0 }],
      { steel: 9999, iron_ingot: 9999, wood: 9999 },
    );
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-platform-constructor');
  });

  it('rejects when requested major radius exceeds the T3 cap of 8', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 99999, wood: 99999 });
    const r = validateConstruction(state, spec, { biome: 'plains', majorRadius: 9, minorRadius: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('radius-too-large');
  });

  it('rejects when requested minor radius exceeds the T3 cap of 8', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 99999, wood: 99999 });
    const r = validateConstruction(state, spec, { biome: 'plains', majorRadius: 4, minorRadius: 12 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('radius-too-large');
  });

  it('rejects zero or negative radius (degenerate ellipse)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 99999, wood: 99999 });
    const r = validateConstruction(state, spec, { biome: 'plains', majorRadius: 0, minorRadius: 4 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('radius-too-large');
  });

  it('rejects when steel is short', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    // Plains 4×4 needs ~252 steel. Give 1.
    const state = makeFounderState([PC_BUILDING], { steel: 1, iron_ingot: 99999, wood: 99999 });
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-materials');
  });

  it('rejects when iron_ingot is short', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 0, wood: 99999 });
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-materials');
  });

  it('rejects when wood is short', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 99999, wood: 0 });
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient-materials');
  });

  it('accepts a valid request', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    const r = validateConstruction(state, spec, okReq);
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('accepts the maximum T3 size (8×8 Plains)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    // 8×8 Plains needs ~1006 steel — give plenty.
    const state = makeFounderState([PC_BUILDING], { steel: 99999, iron_ingot: 99999, wood: 99999 });
    const r = validateConstruction(state, spec, { biome: 'plains', majorRadius: 8, minorRadius: 8 });
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// constructIsland — material drain + new spec/state shape
// ---------------------------------------------------------------------------

describe('constructIsland', () => {
  it('deducts materials from the founder inventory', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], {
      steel: 1000,
      iron_ingot: 1000,
      wood: 1000,
    });
    const cost = computeConstructionCost({ biome: 'plains', majorRadius: 4, minorRadius: 4 });
    constructIsland(
      'WS',
      state,
      spec,
      { biome: 'plains', majorRadius: 4, minorRadius: 4 },
      { cx: 100, cy: 100 },
      'new-1',
      0,
    );
    expect(state.inventory.steel).toBe(1000 - cost.steel);
    expect(state.inventory.iron_ingot).toBe(1000 - cost.iron_ingot);
    expect(state.inventory.wood).toBe(1000 - cost.wood);
  });

  it('returns a populated, discovered, artificial spec with chosen biome and ellipse', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    const result = constructIsland(
      'WS',
      state,
      spec,
      { biome: 'desert', majorRadius: 5, minorRadius: 6 },
      { cx: 50, cy: -30 },
      'desert-art-1',
      0,
    );
    expect(result.newSpec.id).toBe('desert-art-1');
    expect(result.newSpec.biome).toBe('desert');
    expect(result.newSpec.cx).toBe(50);
    expect(result.newSpec.cy).toBe(-30);
    expect(result.newSpec.majorRadius).toBe(5);
    expect(result.newSpec.minorRadius).toBe(6);
    expect(result.newSpec.populated).toBe(true);
    expect(result.newSpec.discovered).toBe(true);
    expect(result.newSpec.artificial).toBe(true);
    expect(result.newSpec.buildings.length).toBe(0);
    expect(Array.isArray(result.newSpec.modifiers)).toBe(true);
    expect(result.newSpec.terrainAt).toBeDefined();
  });

  it('returns a fresh IslandState (level 1, no XP, no skills, no funnel)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    const result = constructIsland(
      'WS',
      state,
      spec,
      { biome: 'plains', majorRadius: 4, minorRadius: 4 },
      { cx: 0, cy: 0 },
      'art-1',
      12345,
    );
    expect(result.newState.id).toBe('art-1');
    expect(result.newState.level).toBe(1);
    expect(result.newState.xp).toBe(0);
    expect(result.newState.unspentSkillPoints).toBe(0);
    expect(result.newState.unlockedNodes.size).toBe(0);
    expect(result.newState.lastTick).toBe(12345);
  });

  it('throws when validation fails (insufficient materials)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 0, iron_ingot: 0, wood: 0 });
    expect(() =>
      constructIsland(
        'WS',
        state,
        spec,
        { biome: 'plains', majorRadius: 4, minorRadius: 4 },
        { cx: 0, cy: 0 },
        'wont-build',
        0,
      ),
    ).toThrow();
  });

  it('throws when validation fails (no Platform Constructor)', () => {
    const spec = makeFounderSpec([]);
    const state = makeFounderState([], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    expect(() =>
      constructIsland(
        'WS',
        state,
        spec,
        { biome: 'plains', majorRadius: 4, minorRadius: 4 },
        { cx: 0, cy: 0 },
        'wont-build',
        0,
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// maxRadiusForFounderLevel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step-12: §9.5 biome-locked-unique gate — Pyroforge on artificial Volcanic
// ---------------------------------------------------------------------------

describe('§9.5 — biome-locked uniques rejected on artificial islands (step 12)', () => {
  it('constructing an artificial Volcanic island then placing a Pyroforge fails canPlaceOnIsland', () => {
    // Setup: T3+ founder with Platform Constructor + plenty of materials,
    // including the volcanic surcharge for a 4×4 volcanic spec.
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState(
      [PC_BUILDING],
      { steel: 9999, iron_ingot: 9999, wood: 9999 },
    );
    const result = constructIsland(
      'WS',
      state,
      spec,
      { biome: 'volcanic', majorRadius: 4, minorRadius: 4 },
      { cx: 200, cy: 200 },
      'art-volcanic-1',
      0,
    );
    // The new island is Volcanic AND artificial. Per §9.5, Pyroforge (the
    // Volcanic-locked unique) cannot be placed here.
    expect(result.newSpec.biome).toBe('volcanic');
    expect(result.newSpec.artificial).toBe(true);
    const pyroforge = BUILDING_DEFS.pyroforge;
    expect(canPlaceOnIsland(pyroforge, result.newSpec)).toBe(false);
    // And via the reasoned wrapper, the rejection carries the correct code.
    const placement = validateBuildingPlacement(pyroforge, result.newSpec);
    expect(placement.ok).toBe(false);
    expect(placement.reason).toBe('artificial-island-biome-locked');
  });

  it('Pyroforge places on a natural Volcanic island (artificial=false)', () => {
    // Sanity: same biome but `artificial` defaults to false → placement OK.
    const naturalVolcanic: IslandSpec = {
      id: 'nat-volc',
      name: 'nat-volc',
      biome: 'volcanic',
      cx: 0,
      cy: 0,
      majorRadius: 7,
      minorRadius: 7,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    expect(canPlaceOnIsland(BUILDING_DEFS.pyroforge, naturalVolcanic)).toBe(true);
    expect(validateBuildingPlacement(BUILDING_DEFS.pyroforge, naturalVolcanic).ok).toBe(true);
  });

  it('biome-mismatch reason is preferred when the artificial island has the wrong biome', () => {
    // An artificial Forest island fails BOTH gates for Pyroforge (biome
    // mismatch AND artificial). `validateBuildingPlacement` reports the
    // biome-mismatch reason (the more actionable error — placement is
    // closed on biome grounds, not just the artificial flag).
    const artForest: IslandSpec = {
      id: 'art-forest',
      name: 'art-forest',
      biome: 'forest',
      cx: 0,
      cy: 0,
      majorRadius: 4,
      minorRadius: 4,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
      artificial: true,
    };
    const result = validateBuildingPlacement(BUILDING_DEFS.pyroforge, artForest);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('biome-mismatch');
  });
});

describe('maxRadiusForFounderLevel', () => {
  it('returns 0 for sub-T3 founders (gating closed)', () => {
    expect(maxRadiusForFounderLevel(1)).toBe(0);
    expect(maxRadiusForFounderLevel(14)).toBe(0);
  });

  it('returns 8 for T3 founders (level 15-29)', () => {
    expect(maxRadiusForFounderLevel(15)).toBe(8);
    expect(maxRadiusForFounderLevel(29)).toBe(8);
  });

  it('returns 12 for T4 founders (level 30-49)', () => {
    expect(maxRadiusForFounderLevel(30)).toBe(12);
    expect(maxRadiusForFounderLevel(49)).toBe(12);
  });

  it('returns 16 for T5 founders (level 50+)', () => {
    expect(maxRadiusForFounderLevel(50)).toBe(16);
    expect(maxRadiusForFounderLevel(100)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// §2.5 artificial-island modifier roll
// ---------------------------------------------------------------------------

describe('§2.5 artificial-island modifier roll', () => {
  it('is deterministic given (worldSeed, biome, islandId, nowMs)', () => {
    const spec = makeFounderSpec([PC_BUILDING]);
    const state = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    const req: ConstructionRequirements = { biome: 'plains', majorRadius: 8, minorRadius: 8 };
    const a = constructIsland('WS', state, spec, req, { cx: 50, cy: 50 }, 'art-1', 1000);
    const stateB = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
    const b = constructIsland('WS', stateB, spec, req, { cx: 50, cy: 50 }, 'art-1', 1000);
    expect(a.newSpec.modifiers).toEqual(b.newSpec.modifiers);
  });

  it('never rolls aetheric_anomaly or frozen_core (§2.5 natural-only)', () => {
    const naturalOnly = new Set<ModifierId>(['aetheric_anomaly', 'frozen_core']);
    for (let i = 0; i < 500; i++) {
      const ids = rollModifiersArtificial('seed', 'volcanic', `art-${i}`, i * 1000);
      for (const id of ids) {
        expect(naturalOnly.has(id)).toBe(false);
      }
    }
  });

  it("does sometimes roll non-empty (artificial isn't a permanent empty list)", () => {
    let nonEmptyCount = 0;
    for (let i = 0; i < 200; i++) {
      const ids = rollModifiersArtificial('seed', 'plains', `art-${i}`, i * 1000);
      if (ids.length > 0) nonEmptyCount++;
    }
    expect(nonEmptyCount).toBeGreaterThan(50);
  });

  it('constructIsland.modifiers is rolled (not hardcoded empty) per §2.5', () => {
    let nonEmpty = 0;
    for (let i = 0; i < 50; i++) {
      const fState = makeFounderState([PC_BUILDING], { steel: 9999, iron_ingot: 9999, wood: 9999 });
      const fSpec = makeFounderSpec([PC_BUILDING]);
      const req: ConstructionRequirements = { biome: 'plains', majorRadius: 8, minorRadius: 8 };
      const r = constructIsland('seed', fState, fSpec, req, { cx: 50 + i, cy: 50 }, `art-${i}`, i * 1000);
      if (r.newSpec.modifiers.length > 0) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(0);
  });
});
