// Tests for `resolveHeatAssignments` per SPEC §5.2.
//
// Pure-layer tests — no DOM, no PixiJS. Verify the adjacency math, the
// free-source-priority rule, the deterministic coal-source assignment, and
// the N:1 server-count aggregation. Each consumer's 4-neighbor border is the
// adjacency surface; "adjacent" means any source-footprint tile lies in that
// border.

import { describe, expect, it, vi } from 'vitest';

import type { PlacedBuilding } from './buildings.js';
import { resolveHeatAssignments, MIN_HEAT_FACTOR } from './heat.js';

vi.mock('./building-defs.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./building-defs.js')>();
  return {
    ...mod,
    BUILDING_DEFS: {
      ...mod.BUILDING_DEFS,
      __test_source_no_kw: {
        id: '__test_source_no_kw',
        displayName: 'Test Source',
        category: 'power',
        tier: 1,
        footprint: { tiles: [{ dx: 0, dy: 0 }] },
        fill: 0,
        stroke: 0,
        heatSource: { freeOrCoal: 'free' },
        glyph: 'S',
      },
      __test_consumer_no_kw: {
        id: '__test_consumer_no_kw',
        displayName: 'Test Consumer',
        category: 'smelting',
        tier: 1,
        footprint: { tiles: [{ dx: 0, dy: 0 }] },
        fill: 0,
        stroke: 0,
        requiresHeat: true,
        glyph: 'C',
      },
      __test_large_coal_source: {
        id: '__test_large_coal_source',
        displayName: 'Test Large Coal Source',
        category: 'power',
        tier: 1,
        footprint: {
          tiles: [
            { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: 2, dy: 0 }, { dx: 3, dy: 0 },
            { dx: 0, dy: 1 }, { dx: 1, dy: 1 }, { dx: 2, dy: 1 }, { dx: 3, dy: 1 },
            { dx: 0, dy: 2 }, { dx: 1, dy: 2 }, { dx: 2, dy: 2 }, { dx: 3, dy: 2 },
            { dx: 0, dy: 3 }, { dx: 1, dy: 3 }, { dx: 2, dy: 3 }, { dx: 3, dy: 3 },
          ],
        },
        fill: 0,
        stroke: 0,
        heatSource: { freeOrCoal: 'free', thermalKW: 830 },
        glyph: 'L',
      },
    } as any,
  };
});

// Layout helpers — every test sets up a small array of PlacedBuilding and
// hands it to the resolver. Building dims are baked into the catalog
// (heat sources from §8.6, smelting consumers from §8.2):
//   coal_furnace      1×1
//   geothermal_vent   2×2
//   plasma_heater     2×2
//   fusion_core       4×4
//   blast_furnace     3×3
//   pyroforge         3×3
//   electric_arc_furnace 2×3
//   coke_oven         2×2

describe('resolveHeatAssignments — §5.2', () => {
  it('no buildings → empty maps', () => {
    const res = resolveHeatAssignments([]);
    expect(res.hasHeat.size).toBe(0);
    expect(res.coalConsumersByFurnace.size).toBe(0);
    expect(res.assignedSource.size).toBe(0);
  });

  it('no heat-required consumers → empty maps even with sources present', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'cf', defId: 'coal_furnace', x: 0, y: 0 },
      { id: 'gv', defId: 'geothermal_vent', x: 10, y: 10 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.size).toBe(0);
    expect(res.coalConsumersByFurnace.size).toBe(0);
  });

  it('Blast Furnace adjacent to free Geothermal Vent → hasHeat, zero coal', () => {
    // Geothermal Vent 2×2 at (3,0): occupies (3,0),(4,0),(3,1),(4,1).
    // Blast Furnace 3×3 at (0,0): occupies (0..2)×(0..2).
    // Border of blast furnace includes (3,0),(3,1),(3,2) along its east edge,
    // which intersects the vent's column at (3,0) and (3,1). Adjacent.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'gv', defId: 'geothermal_vent', x: 3, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(true);
    expect(res.coalConsumersByFurnace.size).toBe(0);
    expect(res.assignedSource.get('bf')).toBe('gv');
  });

  it('Blast Furnace adjacent to Coal Furnace only → hasHeat, served count = 1', () => {
    // Coal Furnace 1×1 at (3,1): occupies (3,1) only — sits in the blast
    // furnace's east-border tile column.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(true);
    expect(res.coalConsumersByFurnace.get('cf')).toBe(1);
    expect(res.assignedSource.get('bf')).toBe('cf');
  });

  it('two consumers sharing one Coal Furnace → served count = 2', () => {
    // Coal Furnace 1×1 at (3,1) — east of blast furnace A.
    // Blast Furnace B sits at (4,0)..(6,2) — its west-border includes (3,0),
    // (3,1),(3,2). The coal furnace at (3,1) is adjacent to both.
    const buildings: PlacedBuilding[] = [
      { id: 'bf-a', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'bf-b', defId: 'blast_furnace', x: 4, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf-a')).toBe(true);
    expect(res.hasHeat.get('bf-b')).toBe(true);
    expect(res.coalConsumersByFurnace.get('cf')).toBe(2);
  });

  it('free source overrides coal: consumer adjacent to BOTH → coalConsumers=0', () => {
    // Blast Furnace at (0,0)..(2,2). Coal Furnace at (3,1). Geothermal Vent at
    // (-2,0)..(-1,1) — west border of blast furnace at column -1 intersects
    // vent tiles (-1,0) and (-1,1). Both adjacent → free wins.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 },
      { id: 'gv', defId: 'geothermal_vent', x: -2, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(true);
    expect(res.coalConsumersByFurnace.size).toBe(0);
    expect(res.assignedSource.get('bf')).toBe('gv');
  });

  it('consumer with NO adjacent source → hasHeat=false', () => {
    // Blast Furnace at (0,0)..(2,2). Coal Furnace at (10,10) — far away.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 10, y: 10 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(false);
    expect(res.coalConsumersByFurnace.size).toBe(0);
    expect(res.assignedSource.has('bf')).toBe(false);
  });

  it('diagonal (corner-only) contact is NOT adjacency', () => {
    // Blast Furnace at (0,0)..(2,2). Coal Furnace at (3,3): touches the
    // blast furnace's SE corner diagonally but shares no 4-neighbor tile.
    // §5.2 / §4.4 are 4-neighbor (cardinal) — diagonal is not adjacent.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 3, y: 3 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(false);
  });

  it('deterministic coal pick: lowest-id when multiple coal sources are adjacent', () => {
    // Two coal furnaces flank the blast furnace on its east side. With
    // both adjacent, §5.2 says pick the lowest cost-per-cycle, tie-break
    // lowest building id. Both have the same coalPerCycle=1, so id breaks.
    // "cf-a" < "cf-z" lexicographically, so cf-a wins.
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf-z', defId: 'coal_furnace', x: 3, y: 2 },
      { id: 'cf-a', defId: 'coal_furnace', x: 3, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.assignedSource.get('bf')).toBe('cf-a');
    expect(res.coalConsumersByFurnace.get('cf-a')).toBe(1);
    expect(res.coalConsumersByFurnace.has('cf-z')).toBe(false);
  });

  it('Pyroforge requires heat (composes with biome gate — placement-side)', () => {
    // Heat resolver only checks adjacency; the volcanic-biome gate is the
    // placement validator's job. Verify that pyroforge's `requiresHeat`
    // flag is honored by the resolver in isolation.
    const buildings: PlacedBuilding[] = [
      { id: 'pf', defId: 'pyroforge', x: 0, y: 0 },
      { id: 'gv', defId: 'geothermal_vent', x: 3, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('pf')).toBe(true);
    expect(res.assignedSource.get('pf')).toBe('gv');
  });

  it('Pyroforge alone (no source) → hasHeat=false', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'pf', defId: 'pyroforge', x: 0, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('pf')).toBe(false);
  });

  it('Coke Oven and Electric Arc Furnace also require heat', () => {
    // Two heat-required consumers, one coal source serves both.
    // Coke Oven 2×2 at (0,0)..(1,1). EAF 2×3 at (4,0)..(5,2). Coal furnace
    // at (2,0): east of coke oven (border includes (2,0)), west of EAF
    // (border includes (3,0)..(3,2)). Coal furnace at column 2 row 0 is in
    // coke oven's east border (2,0) and NOT in EAF's west border (3,*).
    // So coke oven adjacent, EAF not adjacent.
    const buildings: PlacedBuilding[] = [
      { id: 'co', defId: 'coke_oven', x: 0, y: 0 },
      { id: 'eaf', defId: 'electric_arc_furnace', x: 4, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 2, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('co')).toBe(true);
    expect(res.hasHeat.get('eaf')).toBe(false);
    expect(res.coalConsumersByFurnace.get('cf')).toBe(1);
  });

  it('Smelter (T1) is NOT a heat consumer — preserves the bootstrap chain', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'sm', defId: 'smelter', x: 0, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.has('sm')).toBe(false);
  });

  it('Fusion Core acts as a free heat source per §8.5', () => {
    // Fusion Core 4×4 at (-5, -1)..(-2, 2). Blast Furnace at (-1, 0)..(1, 2).
    // West border of BF at column -2 intersects Fusion Core tiles (-2,0),
    // (-2,1),(-2,2). Free source → no coal cost.
    const buildings: PlacedBuilding[] = [
      { id: 'fc', defId: 'fusion_core', x: -5, y: -1 },
      { id: 'bf', defId: 'blast_furnace', x: -1, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('bf')).toBe(true);
    expect(res.assignedSource.get('bf')).toBe('fc');
    expect(res.coalConsumersByFurnace.size).toBe(0);
  });

  it('Plasma Heater also acts as a free heat source per §8.6', () => {
    // Plasma Heater 2×2 at (2,0). Coke Oven 2×2 at (0,0) has east border at
    // column 2 rows 0..1 → overlaps plasma heater tiles (2,0) and (2,1).
    // Uses coke_oven (60 kW) instead of blast_furnace (3000 kW) so the ratio
    // 184/60 = 3.07 > 1 stays above MIN_HEAT_FACTOR.
    const buildings: PlacedBuilding[] = [
      { id: 'co', defId: 'coke_oven', x: 0, y: 0 },
      { id: 'ph', defId: 'plasma_heater', x: 2, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('co')).toBe(true);
    expect(res.assignedSource.get('co')).toBe('ph');
    expect(res.coalConsumersByFurnace.size).toBe(0);
  });

  it('Geothermal Active modifier grants heat to all consumers without adjacent source', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'bf', defId: 'blast_furnace', x: 0, y: 0 },
    ];
    const res = resolveHeatAssignments(buildings, true);
    expect(res.hasHeat.get('bf')).toBe(true);
    expect(res.coalConsumersByFurnace.size).toBe(0);
    expect(res.assignedSource.has('bf')).toBe(false);
  });

  it('N:1 share — three consumers all on one Geothermal Vent → free for all', () => {
    // Geothermal Vent 2×2 at (0,0)..(1,1). Three coke ovens placed around it
    // on the N, E, and S sides — none overlapping each other.
    //   - Coke Oven N at (0,-2)..(1,-1): south border includes (0,0),(1,0).
    //     Actually south border is row -1+1 = 0 → (0,0) and (1,0) are vent
    //     tiles. Adjacent. (Wait — south border of (0,-2)..(1,-1) is row 0
    //     for columns 0,1, which IS inside the vent footprint, so border
    //     tiles (0,0) and (1,0) are in vent. Adjacent.)
    //   - Coke Oven E at (2,0)..(3,1): west border is column 1 for rows 0,1
    //     → (1,0) and (1,1) are vent tiles. Adjacent.
    //   - Coke Oven S at (0,2)..(1,3): north border is row 1 for columns 0,1
    //     → (0,1) and (1,1) are vent tiles. Adjacent.
    const buildings: PlacedBuilding[] = [
      { id: 'gv', defId: 'geothermal_vent', x: 0, y: 0 },
      { id: 'co-n', defId: 'coke_oven', x: 0, y: -2 },
      { id: 'co-e', defId: 'coke_oven', x: 2, y: 0 },
      { id: 'co-s', defId: 'coke_oven', x: 0, y: 2 },
    ];
    const res = resolveHeatAssignments(buildings);
    expect(res.hasHeat.get('co-n')).toBe(true);
    expect(res.hasHeat.get('co-e')).toBe(true);
    expect(res.hasHeat.get('co-s')).toBe(true);
    expect(res.coalConsumersByFurnace.size).toBe(0);
  });
});


describe('heat — proportional throttle (rev-16 §5.1)', () => {
  it('fully feeds 3 coke_ovens (180 kW demand) from plasma_heater (184 kW)', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'ph', defId: 'plasma_heater', x: 0, y: 0 },
      { id: 'co-1', defId: 'coke_oven', x: 2, y: 0 },
      { id: 'co-2', defId: 'coke_oven', x: 0, y: 2 },
      { id: 'co-3', defId: 'coke_oven', x: -2, y: 0 },
    ];
    const result = resolveHeatAssignments(buildings);
    for (const id of ['co-1', 'co-2', 'co-3']) {
      expect(result.heatThrottleFactor.get(id)).toBe(1);
    }
  });

  it('partially throttles 4 coke_ovens (240 kW demand) from plasma_heater (184 kW)', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'ph', defId: 'plasma_heater', x: 0, y: 0 },
      { id: 'co-1', defId: 'coke_oven', x: 2, y: 0 },
      { id: 'co-2', defId: 'coke_oven', x: 0, y: 2 },
      { id: 'co-3', defId: 'coke_oven', x: -2, y: 0 },
      { id: 'co-4', defId: 'coke_oven', x: 0, y: -2 },
    ];
    const result = resolveHeatAssignments(buildings);
    for (const id of ['co-1', 'co-2', 'co-3', 'co-4']) {
      expect(result.heatThrottleFactor.get(id)).toBeCloseTo(184 / 240, 3);
    }
  });

  it('throttles 5 coke_ovens (300 kW demand) to 0.61 each from plasma_heater', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'ph', defId: 'plasma_heater', x: 0, y: 0 },
      { id: 'co-1', defId: 'coke_oven', x: -2, y: -1 },
      { id: 'co-2', defId: 'coke_oven', x: -2, y: 1 },
      { id: 'co-3', defId: 'coke_oven', x: 0, y: -2 },
      { id: 'co-4', defId: 'coke_oven', x: 0, y: 2 },
      { id: 'co-5', defId: 'coke_oven', x: 2, y: -1 },
    ];
    const result = resolveHeatAssignments(buildings);
    for (const id of ['co-1', 'co-2', 'co-3', 'co-4', 'co-5']) {
      expect(result.heatThrottleFactor.get(id)).toBeCloseTo(184 / 300, 3);
    }
  });
});

describe('heat — boolean fallback (pre-Phase-3 compat)', () => {
  it('sets throttle=1.0 when source has no thermalKW', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'src', defId: '__test_source_no_kw' as any, x: 0, y: 0 },
      { id: 'cons', defId: '__test_consumer_no_kw' as any, x: 1, y: 0 },
    ];
    const result = resolveHeatAssignments(buildings);
    expect(result.heatThrottleFactor.get('cons')).toBe(1);
    expect(result.hasHeat.get('cons')).toBe(true);
  });

  it('sets throttle=1.0 when consumer has no heatDemandKW (demand=0)', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'src', defId: '__test_source_no_kw' as any, x: 0, y: 0 },
      { id: 'cons', defId: '__test_consumer_no_kw' as any, x: 1, y: 0 },
    ];
    const result = resolveHeatAssignments(buildings);
    expect(result.heatThrottleFactor.get('cons')).toBe(1);
  });
});

describe('heat — brownout below MIN_HEAT_FACTOR', () => {
  it('fusion_core fully feeds 1 blast_furnace (capped at 1.0)', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'fc', defId: 'fusion_core', x: 0, y: 0 },
      { id: 'bf-1', defId: 'blast_furnace', x: 4, y: 0 },
    ];
    const result = resolveHeatAssignments(buildings);
    expect(result.heatThrottleFactor.get('bf-1')).toBe(1);
  });

  it('coal_furnace + 1 blast_furnace throttles to 0.277 (above threshold)', () => {
    const buildings: PlacedBuilding[] = [
      { id: 'bf-1', defId: 'blast_furnace', x: 0, y: 0 },
      { id: 'cf', defId: 'coal_furnace', x: 3, y: 1 },
    ];
    const result = resolveHeatAssignments(buildings);
    expect(result.heatThrottleFactor.get('bf-1')).toBeCloseTo(830 / 3000, 3);
    expect(result.hasHeat.get('bf-1')).toBe(true);
  });

  it('coal_furnace + 5 blast_furnaces brownouts (below threshold)', () => {
    // Uses a 4×4 mock source (thermalKW 830) so 5 adjacent 3×3 BFs fit.
    const buildings: PlacedBuilding[] = [
      { id: 'src', defId: '__test_large_coal_source' as any, x: 0, y: 0 },
      { id: 'bf-1', defId: 'blast_furnace', x: -3, y: -2 },
      { id: 'bf-2', defId: 'blast_furnace', x: -3, y: 1 },
      { id: 'bf-3', defId: 'blast_furnace', x: -2, y: 4 },
      { id: 'bf-4', defId: 'blast_furnace', x: 0, y: -3 },
      { id: 'bf-5', defId: 'blast_furnace', x: 1, y: 4 },
    ];
    const result = resolveHeatAssignments(buildings);
    for (const id of ['bf-1', 'bf-2', 'bf-3', 'bf-4', 'bf-5']) {
      expect(result.heatThrottleFactor.get(id)).toBeLessThan(MIN_HEAT_FACTOR);
      expect(result.hasHeat.get(id)).toBe(false);
    }
  });
});
