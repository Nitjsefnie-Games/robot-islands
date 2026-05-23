import { describe, expect, it } from 'vitest';
import { attachTerrainAt, type IslandSpec } from './world.js';
import {
  applyTileOverride,
  brushTilesAt,
  conversionCostForTarget,
  K_RARE_MULT,
  NATURAL_PER_TILE_BASKET,
  NATURAL_TARGET_TERRAINS,
  PAYBACK_HORIZON_CYCLES,
  RARE_TARGET_INPUT,
  RARE_TARGET_TERRAINS,
  resolveShot,
  SHOT_DURATION_MS,
} from './terrain-modifier.js';
import { makeInitialIslandState } from './world.js';
import type { PlacedBuilding } from './buildings.js';
import type { TerrainKind } from './island.js';

const ALL_KINDS: TerrainKind[] = [
  'grass', 'stone', 'ore', 'coal', 'water', 'tree', 'sand', 'ice', 'magma_vent',
  'oil_well', 'gas_seep', 'helium_vent', 'limestone', 'clay_pit', 'sulfur_vein',
  'phosphate_deposit', 'graphite_vein', 'copper_vein', 'tin_vein', 'lead_vein',
  'bauxite_vein', 'manganese_vein', 'zinc_vein', 'chromium_vein', 'nickel_vein',
  'tungsten_vein', 'mercury_pit', 'diamond_vein', 'lithium_vein', 'uranium_vein',
];

describe('terrain-modifier — classification coverage', () => {
  it('every TerrainKind belongs to exactly one of NATURAL or RARE', () => {
    for (const k of ALL_KINDS) {
      const inNat = NATURAL_TARGET_TERRAINS.has(k);
      const inRare = RARE_TARGET_TERRAINS.has(k);
      expect(inNat || inRare, `kind ${k} unclassified`).toBe(true);
      expect(inNat && inRare, `kind ${k} double-classified`).toBe(false);
    }
  });

  it('every rare kind has a RARE_TARGET_INPUT row', () => {
    for (const k of RARE_TARGET_TERRAINS) {
      expect(RARE_TARGET_INPUT[k], `rare ${k} missing input mapping`).toBeDefined();
    }
  });
});

describe('terrain-modifier — conversionCostForTarget', () => {
  it('natural targets cost NATURAL_PER_TILE_BASKET × 16', () => {
    const c = conversionCostForTarget('grass');
    expect(c.stone).toBe((NATURAL_PER_TILE_BASKET.stone ?? 0) * 16);
    expect(c.gear).toBe((NATURAL_PER_TILE_BASKET.gear ?? 0) * 16);
  });

  it('rare targets cost K × 1 × horizon × 16 of the input resource', () => {
    const c = conversionCostForTarget('uranium_vein');
    const expected = Math.ceil(K_RARE_MULT * 1 * PAYBACK_HORIZON_CYCLES * 16);
    expect(c.uranium_ore).toBe(expected);
  });

  it('different rare targets bill different resources', () => {
    const cu = conversionCostForTarget('copper_vein');
    const li = conversionCostForTarget('lithium_vein');
    expect(cu.copper_ore).toBeGreaterThan(0);
    expect(li.lithium).toBeGreaterThan(0);
    expect(cu.lithium).toBeUndefined();
  });
});

describe('terrain-modifier — brushTilesAt', () => {
  it('returns exactly 16 tiles', () => {
    const tiles = brushTilesAt(0, 0);
    expect(tiles.length).toBe(16);
  });

  it('covers a 4×4 region centred on the 2×2 footprint', () => {
    const tiles = brushTilesAt(5, 7);
    const xs = tiles.map((t) => t.x);
    const ys = tiles.map((t) => t.y);
    expect(Math.min(...xs)).toBe(4);
    expect(Math.max(...xs)).toBe(7);
    expect(Math.min(...ys)).toBe(6);
    expect(Math.max(...ys)).toBe(9);
  });
});

describe('terrain-modifier — applyTileOverride', () => {
  function makeSpec(): IslandSpec {
    return attachTerrainAt({
      id: 'test', name: 'test', cx: 0, cy: 0, majorRadius: 10, minorRadius: 10,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
  }

  it('creates spec.tileOverrides lazily on first write', () => {
    const spec = makeSpec();
    expect(spec.tileOverrides).toBeUndefined();
    applyTileOverride(spec, 1, 2, 'magma_vent');
    expect(spec.tileOverrides).toEqual({ '1,2': 'magma_vent' });
  });

  it('last-write-wins on key collision', () => {
    const spec = makeSpec();
    applyTileOverride(spec, 0, 0, 'water');
    applyTileOverride(spec, 0, 0, 'uranium_vein');
    expect(spec.tileOverrides?.['0,0']).toBe('uranium_vein');
  });

  it('write is observed by the override-aware closure (Task 1 integration)', () => {
    const spec = makeSpec();
    applyTileOverride(spec, 3, 3, 'diamond_vein');
    expect(spec.terrainAt?.(3, 3)).toBe('diamond_vein');
  });
});

describe('terrain-modifier — constants sanity', () => {
  it('SHOT_DURATION_MS is a positive ms value', () => {
    expect(SHOT_DURATION_MS).toBeGreaterThan(0);
  });
});

describe('terrain-modifier — resolveShot', () => {
  function inscribedAlways(): (x: number, y: number) => boolean {
    return () => true;
  }

  it('writes overrides for every brush tile inside the predicate', () => {
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 0, cy: 0, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    const modifier: PlacedBuilding = {
      id: 'm1', defId: 'terrain_modifier', x: 0, y: 0, rotation: 0,
      terrainTarget: 'uranium_vein', terrainShotRemainingMs: 0,
    };
    state.buildings.push(modifier);
    const result = resolveShot(spec, state, modifier, inscribedAlways());
    expect(result.tilesWritten).toBe(16);
    expect(Object.keys(spec.tileOverrides ?? {}).length).toBe(16);
    expect(state.buildings.find((b) => b.id === 'm1')).toBeUndefined();
  });

  it('skips out-of-ellipse tiles (full charge already paid, no refund)', () => {
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 0, cy: 0, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    const modifier: PlacedBuilding = {
      id: 'm1', defId: 'terrain_modifier', x: 0, y: 0, rotation: 0,
      terrainTarget: 'grass', terrainShotRemainingMs: 0,
    };
    state.buildings.push(modifier);
    // Predicate accepts only y >= 0 tiles — chops off the top row (4 tiles).
    const inscribed = (_x: number, y: number): boolean => y >= 0;
    const result = resolveShot(spec, state, modifier, inscribed);
    expect(result.tilesWritten).toBe(12);
  });

  it('marks a Mine invalid when the override breaks requiredTile', () => {
    // Pre-build an island where tile (5, 5) is `ore` and a Mine sits on it.
    // After resolveShot converts the brush around (5, 5) to grass, the Mine
    // should be invalidated.
    const spec = attachTerrainAt({
      id: 'tt', name: 'tt', cx: 0, cy: 0, majorRadius: 30, minorRadius: 30,
      biome: 'plains', populated: true, discovered: true,
      buildings: [], modifiers: [],
    });
    const state = makeInitialIslandState(spec, 0);
    // Place a Mine at (5, 5) — on natural ore terrain.
    state.buildings.push({
      id: 'mine1', defId: 'mine', x: 5, y: 5, rotation: 0,
    });
    // Place a modifier whose brush covers (5, 5).
    const modifier: PlacedBuilding = {
      id: 'm1', defId: 'terrain_modifier', x: 4, y: 4, rotation: 0,
      terrainTarget: 'grass', terrainShotRemainingMs: 0,
    };
    state.buildings.push(modifier);
    // Before shot: Mine is valid (footprint on ore).
    expect(state.buildings.find((b) => b.id === 'mine1')?.invalid).toBeUndefined();
    const result = resolveShot(spec, state, modifier, inscribedAlways());
    // After shot: Mine is invalidated because its footprint is now grass.
    expect(result.buildingsInvalidated).toBeGreaterThanOrEqual(1);
    expect(state.buildings.find((b) => b.id === 'mine1')?.invalid).toBe(true);
  });
});
