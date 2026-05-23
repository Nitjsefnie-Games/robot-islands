// Tests for `computeBuffStack` per SPEC §4.4 / §4.5.
//
// Pure-layer tests — no DOM, no PixiJS. Verifies that:
//   - A building with no adjacencyBuffs returns the identity multiplier (1.0).
//   - Per-entry stacking is additive within the cap
//     (N matches → multiplier 1 + N × percentPerMatch/100, capped at maxMatches).
//   - Multiple AdjacencyBuff entries compose multiplicatively.
//   - matchKind 'same_def' / 'same_category' / 'def_id' all match on the
//     expected predicate.
//   - Multi-tile neighbors that border the focal footprint on multiple tiles
//     count exactly once (de-duplication by building id).
//   - 4-neighbor adjacency excludes diagonals and self-footprint.

import { describe, expect, it } from 'vitest';

import { checkGates, computeBuffStack } from './adjacency.js';
import {
  BUILDING_DEFS,
  type AdjacencyBuff,
  type BuildingDef,
  type BuildingDefId,
  type GateRequirement,
} from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';


/** Build a one-off catalog override that sets `adjacencyBuffs` on the given
 *  defId, leaving everything else identical to BUILDING_DEFS. Tests use this
 *  so the assertions don't rely on the §4.5 placeholder magnitudes (which
 *  are tunable in Appendix A). */
function withBuffs(
  defId: BuildingDefId,
  buffs: ReadonlyArray<AdjacencyBuff>,
): Readonly<Record<BuildingDefId, BuildingDef>> {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  base[defId] = { ...base[defId], adjacencyBuffs: buffs };
  return base;
}

/** Build a one-off catalog override that sets `gates` on the given defId. */
function withGates(
  defId: BuildingDefId,
  gates: ReadonlyArray<GateRequirement>,
): Readonly<Record<BuildingDefId, BuildingDef>> {
  const base = { ...BUILDING_DEFS } as Record<BuildingDefId, BuildingDef>;
  base[defId] = { ...base[defId], gates };
  return base;
}

describe('computeBuffStack — §4.4 / §4.5', () => {
  it('returns 1.0 for a building whose def has no adjacencyBuffs', () => {
    // The default `dock` def has no adjacencyBuffs.
    const focal: PlacedBuilding = { id: 'd', defId: 'dock', x: 0, y: 0 };
    const others: PlacedBuilding[] = [
      { id: 'm', defId: 'mine', x: 2, y: 0 },
    ];
    expect(computeBuffStack(focal, [focal, ...others])).toBe(1);
  });

  it('returns 1.0 with no matching neighbors (same_def buff, isolated)', () => {
    // 2x2 mine at (0,0); a workshop at (2,0) is adjacent but doesn't match
    // 'same_def' (different defId).
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const buildings: PlacedBuilding[] = [
      focal,
      { id: 'b', defId: 'workshop', x: 2, y: 0 },
    ];
    expect(computeBuffStack(focal, buildings, defs)).toBe(1);
  });

  it('same_def: 1 matching neighbor → 1 + 10/100 = 1.10', () => {
    // 2x2 mines side by side: mine-A at (0,0) covers (0..1, 0..1),
    // mine-B at (2,0) covers (2..3, 0..1). Mine-A's east border includes
    // (2,0),(2,1) which are mine-B's western tiles → adjacent.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const a: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    expect(computeBuffStack(a, [a, b], defs)).toBeCloseTo(1.1, 9);
    expect(computeBuffStack(b, [a, b], defs)).toBeCloseTo(1.1, 9);
  });

  it('same_def: 2 matching neighbors → 1 + 2 × 10/100 = 1.20 (under cap)', () => {
    // Center mine flanked east + west by two more 2x2 mines.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const west: PlacedBuilding = { id: 'w', defId: 'mine', x: -2, y: 0 };
    const mid: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0 };
    const east: PlacedBuilding = { id: 'e', defId: 'mine', x: 2, y: 0 };
    const buildings = [west, mid, east];
    expect(computeBuffStack(mid, buildings, defs)).toBeCloseTo(1.2, 9);
    // Outer mines each have exactly one neighbor.
    expect(computeBuffStack(west, buildings, defs)).toBeCloseTo(1.1, 9);
    expect(computeBuffStack(east, buildings, defs)).toBeCloseTo(1.1, 9);
  });

  it('same_def: 3 matching neighbors caps at maxMatches=2 → 1.20', () => {
    // Center mine flanked west, east, AND north. 3 neighbors but cap=2.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const west: PlacedBuilding = { id: 'w', defId: 'mine', x: -2, y: 0 };
    const mid: PlacedBuilding = { id: 'm', defId: 'mine', x: 0, y: 0 };
    const east: PlacedBuilding = { id: 'e', defId: 'mine', x: 2, y: 0 };
    const north: PlacedBuilding = { id: 'n', defId: 'mine', x: 0, y: -2 };
    const buildings = [west, mid, east, north];
    expect(computeBuffStack(mid, buildings, defs)).toBeCloseTo(1.2, 9);
  });

  it('same_category: counts neighbors sharing the def category, not defId', () => {
    // Mine + Logger are both `extraction`. A same_category buff on mine
    // should count a neighboring Logger as a match.
    const defs = withBuffs('mine', [
      { matchKind: 'same_category', percentPerMatch: 20, maxMatches: 3 },
    ]);
    const mineA: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    // Logger is 1x1; place at (2,0) — east of mine's footprint.
    const logger: PlacedBuilding = { id: 'l', defId: 'logger', x: 2, y: 0 };
    // Workshop (manufacturing) at (2,-2) doesn't match the category.
    // Actually let's make sure a non-extraction neighbor doesn't count by
    // putting the workshop at (0,-2) — north of the mine.
    const workshop: PlacedBuilding = { id: 'w', defId: 'workshop', x: 0, y: -2 };
    const buildings = [mineA, logger, workshop];
    // Logger counts (same category), workshop does not.
    expect(computeBuffStack(mineA, buildings, defs)).toBeCloseTo(1.2, 9);
  });

  it('def_id: only the named defId counts', () => {
    // Mine adjacent to logger AND another mine. def_id buff targeting
    // 'logger' only counts the logger.
    const defs = withBuffs('mine', [
      { matchKind: 'def_id', matchDefId: 'logger', percentPerMatch: 25, maxMatches: 5 },
    ]);
    const mineA: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const mineB: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    const logger: PlacedBuilding = { id: 'l', defId: 'logger', x: 0, y: -1 };
    const buildings = [mineA, mineB, logger];
    expect(computeBuffStack(mineA, buildings, defs)).toBeCloseTo(1.25, 9);
  });

  it('multiple buff entries compose multiplicatively', () => {
    // Mine with two buff entries:
    //   1. same_def: +10% per match, cap 2  → 1 match → ×1.10
    //   2. def_id 'logger': +20% per match, cap 1 → 1 match → ×1.20
    // Total: 1.10 × 1.20 = 1.32.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
      { matchKind: 'def_id', matchDefId: 'logger', percentPerMatch: 20, maxMatches: 1 },
    ]);
    const mineA: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const mineB: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    const logger: PlacedBuilding = { id: 'l', defId: 'logger', x: 0, y: -1 };
    const buildings = [mineA, mineB, logger];
    expect(computeBuffStack(mineA, buildings, defs)).toBeCloseTo(1.10 * 1.20, 9);
  });

  it('multi-tile neighbor sharing multiple border tiles counts as ONE match', () => {
    // Mine 2x2 at (0,0) covers (0..1, 0..1). Place a second 2x2 mine at
    // (2,0) — it shares two border tiles with the focal (it touches (0,0)'s
    // border at (2,0) and (2,1)). Despite touching twice, the same building
    // id must contribute exactly one match.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 50, maxMatches: 10 },
    ]);
    const a: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    // Only one match expected → 1 + 1 × 0.5 = 1.5, not 2.0 (which would
    // be the result if the two-tile border counted twice).
    expect(computeBuffStack(a, [a, b], defs)).toBeCloseTo(1.5, 9);
  });

  it('diagonal neighbors do NOT count (4-neighbor only, no 8-neighbor)', () => {
    // Mine 2x2 at (0,0); second mine 2x2 at (2,2) — touches only at the
    // corner. 4-neighbor adjacency excludes the corner-touch.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const a: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const b: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 2 };
    expect(computeBuffStack(a, [a, b], defs)).toBe(1);
  });

  it('self is never counted as a match', () => {
    // A single mine with a same_def buff on itself returns 1.0.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const a: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    expect(computeBuffStack(a, [a], defs)).toBe(1);
  });

  it('default defs parameter falls back to BUILDING_DEFS', () => {
    // Smoke test: calling without a defs argument should not throw and
    // should return 1.0 for a def with no placeholder buff (or the
    // configured placeholder multiplier if the def has one). We use
    // 'dock' which is not in the placeholder list.
    const focal: PlacedBuilding = { id: 'd', defId: 'dock', x: 0, y: 0 };
    expect(computeBuffStack(focal, [focal])).toBe(1);
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

  it('§13.3 cross-island: remote building counts as neighbor for buff', () => {
    // Focal mine has no local same_def neighbors, but a remote mine on
    // another island is passed as crossIsland → should count.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const remote: PlacedBuilding = { id: 'remote', defId: 'mine', x: 999, y: 999 };
    expect(computeBuffStack(focal, [focal], defs, [remote])).toBeCloseTo(1.1, 9);
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

  it('§13.3 cross-island: self-id in crossIsland is ignored', () => {
    // A remote building with the same id as focal should not count.
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const remoteSameId: PlacedBuilding = { id: 'a', defId: 'mine', x: 999, y: 999 };
    expect(computeBuffStack(focal, [focal], defs, [remoteSameId])).toBe(1);
  });
});


describe('exoticAdjacency — pairBoost', () => {
  it('applies pairBoost when focal and neighbor match the pair', () => {
    const focal: PlacedBuilding = { id: 'a', defId: 'smelter', x: 0, y: 0 };
    const neighbor: PlacedBuilding = { id: 'b', defId: 'coal_gen', x: 2, y: 0 };
    const rules = [{ pair: ['smelter', 'coal_gen'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(focal, [focal, neighbor], BUILDING_DEFS, undefined, rules)).toBeCloseTo(1.25, 9);
  });

  it('does not apply pairBoost without matching neighbor', () => {
    const focal: PlacedBuilding = { id: 'a', defId: 'smelter', x: 0, y: 0 };
    const neighbor: PlacedBuilding = { id: 'b', defId: 'workshop', x: 2, y: 0 };
    const rules = [{ pair: ['smelter', 'coal_gen'] as const, recipeRateBonus: 0.25 }];
    expect(computeBuffStack(focal, [focal, neighbor], BUILDING_DEFS, undefined, rules)).toBe(1);
  });

  it('stacks multiple exotic rules multiplicatively', () => {
    const focal: PlacedBuilding = { id: 'a', defId: 'smelter', x: 0, y: 0 };
    const neighbor1: PlacedBuilding = { id: 'b', defId: 'coal_gen', x: 2, y: 0 };
    const neighbor2: PlacedBuilding = { id: 'c', defId: 'solar', x: 0, y: -1 };
    const rules = [
      { pair: ['smelter', 'coal_gen'] as const, recipeRateBonus: 0.25 },
      { pair: ['smelter', 'solar'] as const, recipeRateBonus: 0.10 },
    ];
    expect(computeBuffStack(focal, [focal, neighbor1, neighbor2], BUILDING_DEFS, undefined, rules)).toBeCloseTo(1.25 * 1.10, 9);
  });

  it('works alongside native adjacencyBuffs', () => {
    const defs = withBuffs('mine', [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ]);
    const focal: PlacedBuilding = { id: 'a', defId: 'mine', x: 0, y: 0 };
    const sameDefNeighbor: PlacedBuilding = { id: 'b', defId: 'mine', x: 2, y: 0 };
    const exoticNeighbor: PlacedBuilding = { id: 'c', defId: 'coal_gen', x: 0, y: -2 };
    const rules = [{ pair: ['mine', 'coal_gen'] as const, recipeRateBonus: 0.20 }];
    // Native buff: same_def mine neighbor → 1.10
    // Exotic buff: coal_gen neighbor → 1.20
    // Total: 1.10 * 1.20 = 1.32
    expect(computeBuffStack(focal, [focal, sameDefNeighbor, exoticNeighbor], defs, undefined, rules)).toBeCloseTo(1.32, 9);
  });

  it('applies pairBoost even when building has no native adjacencyBuffs', () => {
    const focal: PlacedBuilding = { id: 'a', defId: 'dock', x: 0, y: 0 };
    const neighbor: PlacedBuilding = { id: 'b', defId: 'coal_gen', x: 2, y: 0 };
    const rules = [{ pair: ['dock', 'coal_gen'] as const, recipeRateBonus: 0.30 }];
    expect(computeBuffStack(focal, [focal, neighbor], BUILDING_DEFS, undefined, rules)).toBeCloseTo(1.30, 9);
  });
});
