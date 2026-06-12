// Pure-layer tests for `computeBuffStack` per SPEC §4.4 / §4.5 — no DOM, no PixiJS.

import { describe, expect, it } from 'vitest';

import { checkGates, clusterBonusMul, clusterBonusMuls, computeBuffStack } from './adjacency.js';
import {
  BUILDING_DEFS,
  type BuildingDef,
  type BuildingDefId,
  type GateRequirement,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';

/** Build a one-off catalog override that sets `gates` on the given defId. */
function withGates(
  defId: BuildingDefId,
  gates: ReadonlyArray<GateRequirement>,
): Readonly<Record<BuildingDefId, BuildingDef>> {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  base[defId] = { ...base[defId], gates };
  return base;
}

describe('computeBuffStack — category × exotic', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as never;

  it('equals the cluster term when no exotic rules apply', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(computeBuffStack(a, [a, b])).toBeCloseTo(1.05, 9);
  });

  it('exotic pair bonus stacks multiplicatively on top of the category term', () => {
    // Two adjacent mines → category ×1.05. An exotic rule pairing
    // mine→smelter with +0.25 fires only when a smelter neighbour exists.
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const sm = place('sm', 'smelter', 0, 2); // borders a's bottom edge
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b, sm], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.05 * 1.25, 9);
  });

  it('exotic rule with no matching neighbour leaves the stack at the category term', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.05, 9);
  });

  it('multiple exotic rules stack multiplicatively (category term isolated at 1.0)', () => {
    // Focal mine has NO same-category (mine) neighbour → category mul = 1.0.
    // A smelter and a workshop border it; two exotic rules fire → 1.25 × 1.10.
    const a = place('a', 'mine', 0, 0);
    const sm = place('sm', 'smelter', 0, 2);  // borders a's bottom edge
    const ws = place('ws', 'workshop', 2, 0); // borders a's right edge
    const rules = [
      { pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 },
      { pair: ['mine', 'workshop'] as const, recipeRateBonus: 0.10 },
    ];
    expect(computeBuffStack(a, [a, sm, ws], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.25 * 1.10, 9);
  });

  it('pure exotic in isolation: category mul 1.0 × single exotic = 1.25', () => {
    // Focal mine with only a smelter neighbour → no same-category neighbour
    // (category mul 1.0), exotic mine→smelter fires → 1.25 exactly.
    const a = place('a', 'mine', 0, 0);
    const sm = place('sm', 'smelter', 0, 2);
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, sm], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.25, 9);
  });
});

describe('checkGates — §4.5 gating adjacency', () => {
  it('building with no gates → satisfied, mul=1', () => {
    const focal: PlacedBuilding = { id: 'd', defId: 'dock', x: 0, y: 0 };
    expect(checkGates(focal, [focal])).toEqual({ satisfied: true, effectiveMul: 1 });
  });

  it('hard gate met → satisfied, mul=1', () => {
    const defs = withGates('coke_oven', [{ matchType: 'heat_source', hard: true }]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    const heater: PlacedBuilding = { id: 'h', defId: 'coal_furnace', x: 2, y: 0 };
    expect(checkGates(focal, [focal, heater], defs)).toEqual({ satisfied: true, effectiveMul: 1 });
  });

  it('hard gate unmet → unsatisfied, mul=0', () => {
    const defs = withGates('coke_oven', [{ matchType: 'heat_source', hard: true }]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    expect(checkGates(focal, [focal], defs)).toEqual({ satisfied: false, effectiveMul: 0 });
  });

  it('soft gate unmet → unsatisfied, mul=degradeMul', () => {
    const defs = withGates('coke_oven', [{ matchType: 'heat_source', hard: false, degradeMul: 0.3 }]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    expect(checkGates(focal, [focal], defs)).toEqual({ satisfied: false, effectiveMul: 0.3 });
  });

  it('multiple soft gates take the minimum degradeMul', () => {
    const defs = withGates('coke_oven', [
      { matchType: 'heat_source', hard: false, degradeMul: 0.5 },
      { matchType: 'def_id', defId: 'coal_furnace', hard: false, degradeMul: 0.4 },
    ]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    // No neighbors → both unmet → min(0.5, 0.4) = 0.4
    expect(checkGates(focal, [focal], defs)).toEqual({ satisfied: false, effectiveMul: 0.4 });
  });

  it('same_def match type', () => {
    // same_def means "neighbor has the same defId as the focal building";
    // gate.defId is ignored for this matchType.
    const defs = withGates('mine', [
      { matchType: 'same_def', hard: true },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const other: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    expect(checkGates(focal, [focal, other], defs)).toEqual({ satisfied: true, effectiveMul: 1 });

    const workshop: PlacedBuilding = { id: 'w', defId: 'workshop', x: 2, y: 0 };
    expect(checkGates(focal, [focal, workshop], defs)).toEqual({ satisfied: false, effectiveMul: 0 });
  });

  it('def_id match type', () => {
    const defs = withGates('mine', [
      { matchType: 'def_id', defId: 'logger', hard: true },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const logger: PlacedBuilding = { id: 'l', defId: 'logger', x: 2, y: 0 };
    expect(checkGates(focal, [focal, logger], defs)).toEqual({ satisfied: true, effectiveMul: 1 });

    const workshop: PlacedBuilding = { id: 'w', defId: 'workshop', x: 2, y: 0 };
    expect(checkGates(focal, [focal, workshop], defs)).toEqual({ satisfied: false, effectiveMul: 0 });
  });

  it('heat_source match type', () => {
    const defs = withGates('coke_oven', [
      { matchType: 'heat_source', hard: true },
    ]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    const heater: PlacedBuilding = { id: 'h', defId: 'coal_furnace', x: 2, y: 0 };
    expect(checkGates(focal, [focal, heater], defs)).toEqual({ satisfied: true, effectiveMul: 1 });

    const nonHeater: PlacedBuilding = { id: 'w', defId: 'workshop', x: 2, y: 0 };
    expect(checkGates(focal, [focal, nonHeater], defs)).toEqual({ satisfied: false, effectiveMul: 0 });
  });

  it('same_category match type', () => {
    const defs = withGates('mine', [
      { matchType: 'same_category', category: 'extraction', hard: true },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const logger: PlacedBuilding = { id: 'l', defId: 'logger', x: 2, y: 0 };
    expect(checkGates(focal, [focal, logger], defs)).toEqual({ satisfied: true, effectiveMul: 1 });

    const workshop: PlacedBuilding = { id: 'w', defId: 'workshop', x: 2, y: 0 };
    expect(checkGates(focal, [focal, workshop], defs)).toEqual({ satisfied: false, effectiveMul: 0 });
  });

  it('minCount=2 with only 1 matching neighbor: hard gate zeros, soft gate degrades', () => {
    const defs = withGates('mine', [
      { matchType: 'same_def', minCount: 2, hard: true },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const neighbor: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    // Only 1 matching neighbor but minCount=2 → hard gate fails
    expect(checkGates(focal, [focal, neighbor], defs)).toEqual({ satisfied: false, effectiveMul: 0 });

    const softDefs = withGates('mine', [
      { matchType: 'same_def', minCount: 2, hard: false, degradeMul: 0.25 },
    ]);
    // Soft gate with 1 match → degraded
    expect(checkGates(focal, [focal, neighbor], softDefs)).toEqual({ satisfied: false, effectiveMul: 0.25 });
  });

  it('§13.3 cross-island: remote building satisfies hard gate', () => {
    const defs = withGates('coke_oven', [{ matchType: 'heat_source', hard: true }]);
    const focal: PlacedBuilding = { id: 'c', defId: 'coke_oven', x: 0, y: 0 };
    const remoteHeater: PlacedBuilding = { id: 'h-remote', defId: 'coal_furnace', x: 999, y: 999 };
    expect(checkGates(focal, [focal], defs, false, [remoteHeater])).toEqual({
      satisfied: true,
      effectiveMul: 1,
    });
  });
});

describe('clusterBonusMul — §4.5 per-cluster bonus', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as unknown as PlacedBuilding;

  it('isolated building → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(clusterBonusMul(a, [a])).toBe(1);
  });

  it('pair (cluster size 2) → 1 + 1 × 0.05 = 1.05, both members', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.05, 9);
    expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.05, 9);
  });

  it('line of 3 → uniform 1.10 (was: centre 1.20, ends 1.10)', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const c = place('c', 'mine', 4, 0);
    const all = [a, b, c];
    expect(clusterBonusMul(a, all)).toBeCloseTo(1.1, 9);
    expect(clusterBonusMul(b, all)).toBeCloseTo(1.1, 9);
    expect(clusterBonusMul(c, all)).toBeCloseTo(1.1, 9);
  });

  it('cross of 5 → uniform 1.20 across centre AND arms (was: arms 1.10)', () => {
    const mid = place('mid', 'mine', 0, 0);
    const n = place('n', 'mine', 0, -2);
    const s = place('s', 'mine', 0, 2);
    const e = place('e', 'mine', 2, 0);
    const w = place('w', 'mine', -2, 0);
    const all = [mid, n, s, e, w];
    for (const b of all) expect(clusterBonusMul(b, all)).toBeCloseTo(1.2, 9);
  });

  it('ring of 8 around a hole → one cluster of 8, all ×1.35 (R1: hole ignored)', () => {
    // 3×3 block of 2×2 mines at spacing 2, centre tile (2,2) empty.
    const ids = [
      place('p00', 'mine', 0, 0), place('p20', 'mine', 2, 0), place('p40', 'mine', 4, 0),
      place('p02', 'mine', 0, 2),                              place('p42', 'mine', 4, 2),
      place('p04', 'mine', 0, 4), place('p24', 'mine', 2, 4), place('p44', 'mine', 4, 4),
    ];
    for (const b of ids) expect(clusterBonusMul(b, ids)).toBeCloseTo(1.35, 9);
  });

  it('different-category building between two mines does NOT bridge them (M E M)', () => {
    // mine — workshop — mine, all spacing 2. The workshop is a different
    // category, so the two mines are not connected: two clusters of size 1.
    const m1 = place('m1', 'mine', 0, 0);
    const w = place('w', 'workshop', 2, 0);
    const m2 = place('m2', 'mine', 4, 0);
    const all = [m1, w, m2];
    expect(clusterBonusMul(m1, all)).toBe(1);
    expect(clusterBonusMul(m2, all)).toBe(1);
    expect(clusterBonusMul(w, all)).toBe(1);
  });

  it('two disjoint same-category clusters scale independently', () => {
    // Cluster A: pair at x=0,2 (size 2 → 1.05). Cluster B: triple at x=10,12,14 (size 3 → 1.10).
    const a1 = place('a1', 'mine', 0, 0);
    const a2 = place('a2', 'mine', 2, 0);
    const b1 = place('b1', 'mine', 10, 0);
    const b2 = place('b2', 'mine', 12, 0);
    const b3 = place('b3', 'mine', 14, 0);
    const all = [a1, a2, b1, b2, b3];
    expect(clusterBonusMul(a1, all)).toBeCloseTo(1.05, 9);
    expect(clusterBonusMul(b1, all)).toBeCloseTo(1.1, 9);
    expect(clusterBonusMul(b3, all)).toBeCloseTo(1.1, 9);
  });

  it('diagonal-only contact does NOT connect (4-adjacency)', () => {
    const a = place('a', 'mine', 0, 0);
    const d = place('d', 'mine', 2, 2);
    expect(clusterBonusMul(a, [a, d])).toBe(1);
    expect(clusterBonusMul(d, [a, d])).toBe(1);
  });

  it('duplicate id (degenerate) → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(clusterBonusMul(a, [a, a])).toBe(1);
  });

  it('batch clusterBonusMuls agrees with single clusterBonusMul', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const c = place('c', 'mine', 4, 0);
    const all = [a, b, c];
    const map = clusterBonusMuls(all);
    for (const x of all) {
      expect(map.get(x.id)).toBeCloseTo(clusterBonusMul(x, all), 9);
    }
    expect(map.get('a')).toBeCloseTo(1.1, 9);
  });

  it('floor-weighted: a taller neighbour raises others’ bonus; own bonus excludes own capacity', () => {
    // a = floor-1 (c=1), b = floor-3 (floorLevel 2 → c=3), adjacent. K = 4.
    // mul_a = 1 + 0.05×(4−1) = 1.15 ; mul_b = 1 + 0.05×(4−3) = 1.05
    const a = place('a', 'mine', 0, 0);
    const b = { ...place('b', 'mine', 2, 0), floorLevel: 2 };
    expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.15, 9);
    expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.05, 9);
  });

  it('floor-weighted: a lone tall building gets NO self-bonus (×1.0)', () => {
    // floorLevel 4 → c=5, K=5, 1 + 0.05×(5−5) = 1.0
    const a = { ...place('a', 'mine', 0, 0), floorLevel: 4 };
    expect(clusterBonusMul(a, [a])).toBe(1);
  });

  it('floor-weighted: levels beyond 9 count toward cluster capacity', () => {
    // floorLevel 10 → c=11. Two adjacent mines: K = 12.
    // a gets 1 + 0.05×(12 − 11) = 1.05; b gets 1 + 0.05×(12 − 1) = 1.55.
    const a = { ...place('a', 'mine', 0, 0), floorLevel: 10 };
    const b = place('b', 'mine', 2, 0);
    expect(clusterBonusMul(a, [a, b])).toBeCloseTo(1.05, 9);
    expect(clusterBonusMul(b, [a, b])).toBeCloseTo(1.55, 9);
  });
});
