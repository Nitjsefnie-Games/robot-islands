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
  SHOT_DURATION_MS,
} from './terrain-modifier.js';
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
