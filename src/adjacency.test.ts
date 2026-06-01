// Pure-layer tests for `computeBuffStack` per SPEC §4.4 / §4.5 — no DOM, no PixiJS.

import { describe, expect, it } from 'vitest';

import { categoryAdjacencyMul, checkGates, computeBuffStack } from './adjacency.js';
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

  it('equals categoryAdjacencyMul when no exotic rules apply', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(computeBuffStack(a, [a, b])).toBeCloseTo(1.1, 9);
  });

  it('exotic pair bonus stacks multiplicatively on top of the category term', () => {
    // Two adjacent mines → category ×1.10. An exotic rule pairing
    // mine→smelter with +0.25 fires only when a smelter neighbour exists.
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const sm = place('sm', 'smelter', 0, 2); // borders a's bottom edge
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b, sm], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.1 * 1.25, 9);
  });

  it('exotic rule with no matching neighbour leaves the stack at the category term', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    const rules = [{ pair: ['mine', 'smelter'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(a, [a, b], BUILDING_DEFS, undefined, rules))
      .toBeCloseTo(1.1, 9);
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

describe('categoryAdjacencyMul — §4.5 universal category adjacency', () => {
  const place = (id: string, defId: string, x: number, y: number) =>
    ({ id, defId: defId as never, x, y }) as never;

  it('isolated building → 1.0', () => {
    const a = place('a', 'mine', 0, 0);
    expect(categoryAdjacencyMul(a, [a])).toBe(1);
  });

  it('1 same-category neighbour → 1 + 1 × 0.10 = 1.10', () => {
    const a = place('a', 'mine', 0, 0);
    const b = place('b', 'mine', 2, 0);
    expect(categoryAdjacencyMul(a, [a, b])).toBeCloseTo(1.1, 9);
    expect(categoryAdjacencyMul(b, [a, b])).toBeCloseTo(1.1, 9);
  });

  it('uncapped: 4 same-category neighbours → 1 + 4 × 0.10 = 1.40', () => {
    const mid = place('mid', 'mine', 0, 0);
    const n = place('n', 'mine', 0, -2);
    const s = place('s', 'mine', 0, 2);
    const e = place('e', 'mine', 2, 0);
    const w = place('w', 'mine', -2, 0);
    expect(categoryAdjacencyMul(mid, [mid, n, s, e, w])).toBeCloseTo(1.4, 9);
  });

  it('different category does not count (mine vs workshop)', () => {
    const mine = place('mine', 'mine', 0, 0);
    const shop = place('shop', 'workshop', 2, 0);
    expect(categoryAdjacencyMul(mine, [mine, shop])).toBe(1);
  });

  it('diagonal neighbour does NOT count (4-neighbour rule)', () => {
    const a = place('a', 'mine', 0, 0);
    const d = place('d', 'mine', 2, 2);
    expect(categoryAdjacencyMul(a, [a, d])).toBe(1);
  });

  it('self is never counted', () => {
    const a = place('a', 'mine', 0, 0);
    expect(categoryAdjacencyMul(a, [a, a])).toBe(1);
  });
});
