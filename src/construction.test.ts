import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  BASE_CONSTRUCTION_MS_BY_TIER,
  constructionProgress,
  constructionTimeFor,
  isOperational,
  nextConstructionCompletionMs,
  tickConstruction,
  upgradeConstructionMs,
} from './construction.js';

function mkBuilding(remaining?: number): PlacedBuilding {
  return {
    id: 'b',
    defId: 'mine',
    x: 0,
    y: 0,
    ...(remaining !== undefined ? { constructionRemainingMs: remaining } : {}),
  };
}

describe('constructionTimeFor', () => {
  it('returns the base tier time at multiplier 1', () => {
    expect(constructionTimeFor(BUILDING_DEFS.mine, 1)).toBe(BASE_CONSTRUCTION_MS_BY_TIER[1]);
  });

  it('halves the time at multiplier 2', () => {
    expect(constructionTimeFor(BUILDING_DEFS.mine, 2)).toBe(
      Math.round(BASE_CONSTRUCTION_MS_BY_TIER[1] / 2),
    );
  });

  it('handles non-positive multipliers by falling back to base (defensive)', () => {
    expect(constructionTimeFor(BUILDING_DEFS.mine, 0)).toBe(BASE_CONSTRUCTION_MS_BY_TIER[1]);
  });

  it('scales with tier (T6 ≫ T1)', () => {
    expect(BASE_CONSTRUCTION_MS_BY_TIER[6]).toBeGreaterThan(BASE_CONSTRUCTION_MS_BY_TIER[1]);
  });
});

describe('isOperational', () => {
  it('returns true when remaining is 0', () => {
    expect(isOperational(mkBuilding(0))).toBe(true);
  });

  it('returns true when remaining is missing (legacy save forward-compat)', () => {
    expect(isOperational(mkBuilding())).toBe(true);
  });

  it('returns false when remaining > 0', () => {
    expect(isOperational(mkBuilding(1000))).toBe(false);
  });
});

describe('tickConstruction', () => {
  it('decrements remaining by dt and returns false when not yet complete', () => {
    const b = mkBuilding(5000);
    expect(tickConstruction(b, 1000)).toBe(false);
    expect(b.constructionRemainingMs).toBe(4000);
  });

  it('returns true and clamps to 0 when dt crosses the threshold', () => {
    const b = mkBuilding(500);
    expect(tickConstruction(b, 1000)).toBe(true);
    expect(b.constructionRemainingMs).toBe(0);
  });

  it('is a no-op when already operational', () => {
    const b = mkBuilding(0);
    expect(tickConstruction(b, 1000)).toBe(false);
    expect(b.constructionRemainingMs).toBe(0);
  });

  it('handles missing field as operational', () => {
    const b = mkBuilding();
    expect(tickConstruction(b, 1000)).toBe(false);
    expect(b.constructionRemainingMs).toBeUndefined();
  });
});

describe('nextConstructionCompletionMs', () => {
  it('returns null when nothing is under construction', () => {
    expect(nextConstructionCompletionMs([mkBuilding(0), mkBuilding()], 1000)).toBeNull();
  });

  it('returns the EARLIEST completion event among multiple in-progress builds', () => {
    const a: PlacedBuilding = { ...mkBuilding(5000), id: 'a' };
    const b: PlacedBuilding = { ...mkBuilding(2000), id: 'b' };
    const c: PlacedBuilding = { ...mkBuilding(10000), id: 'c' };
    expect(nextConstructionCompletionMs([a, b, c], 1000)).toBe(1000 + 2000);
  });
});

describe('constructionProgress', () => {
  const mine = BUILDING_DEFS.mine; // tier 1
  const BASE = BASE_CONSTRUCTION_MS_BY_TIER[1];

  it('runs 0 → 1 over a fresh placement (floor 0, total = base)', () => {
    expect(constructionProgress(BASE, mine, 0)).toBe(0);
    expect(constructionProgress(BASE / 2, mine, 0)).toBe(0.5);
    expect(constructionProgress(0, mine, 0)).toBe(1);
  });

  it('runs 0 → 1 over a floor-1 upgrade (total = 2×base) — NOT empty for the first half', () => {
    // The bug: the arc divided by the fixed placement base, so a 2×base upgrade
    // read 0 until remaining dropped below base (the first half). It must use
    // the job's real duration instead.
    const total = upgradeConstructionMs(mine, 1); // 2 × base
    expect(constructionProgress(total, mine, 1)).toBe(0); // start, not negative/clamped
    expect(constructionProgress(BASE, mine, 1)).toBeCloseTo(0.5, 10); // halfway → 0.5, was 0
    expect(constructionProgress(0, mine, 1)).toBe(1);
  });

  it('clamps to [0,1]', () => {
    expect(constructionProgress(BASE * 5, mine, 0)).toBe(0);
    expect(constructionProgress(-100, mine, 0)).toBe(1);
  });
});
