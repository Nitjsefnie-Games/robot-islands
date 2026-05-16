import { describe, expect, it } from 'vitest';

import { BUILDING_DEFS } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import {
  BASE_CONSTRUCTION_MS_BY_TIER,
  constructionTimeFor,
  isOperational,
  nextConstructionCompletionMs,
  tickConstruction,
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
    const a = mkBuilding(5000);
    a.id = 'a';
    const b = mkBuilding(2000);
    b.id = 'b';
    const c = mkBuilding(10000);
    c.id = 'c';
    expect(nextConstructionCompletionMs([a, b, c], 1000)).toBe(1000 + 2000);
  });
});
