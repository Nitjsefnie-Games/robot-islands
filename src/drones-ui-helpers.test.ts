import { describe, it, expect } from 'vitest';
import {
  tileDist,
  totalPathTiles,
  wouldExceedRange,
  fuelForPath,
  popTrailingDuplicate,
} from './drones-ui-helpers.js';
import { MAX_FUEL_PER_DRONE } from './drones.js';

describe('tileDist', () => {
  it('returns 0 for identical points', () => {
    expect(tileDist({ x: 5, y: 7 }, { x: 5, y: 7 })).toBe(0);
  });
  it('returns Pythagorean distance', () => {
    expect(tileDist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});

describe('totalPathTiles', () => {
  it('returns 0 for empty waypoints', () => {
    expect(totalPathTiles({ x: 0, y: 0 }, [])).toBe(0);
  });
  it('sums origin → wp[0] only for a single waypoint', () => {
    expect(totalPathTiles({ x: 0, y: 0 }, [{ x: 3, y: 4 }])).toBe(5);
  });
  it('chains origin → wp[0] → wp[1] for two waypoints', () => {
    const total = totalPathTiles({ x: 0, y: 0 }, [{ x: 3, y: 0 }, { x: 3, y: 4 }]);
    expect(total).toBe(7); // 3 + 4
  });
});

describe('wouldExceedRange', () => {
  // Max one-way = MAX_FUEL × T5_EFF = 50 × 8 = 400 tiles (#117 one-way path drones)
  it('allows a 399-tile path with one more 1-tile hop (400 exactly)', () => {
    const result = wouldExceedRange(
      { x: 0, y: 0 },
      [{ x: 399, y: 0 }],
      { x: 400, y: 0 },
    );
    expect(result).toBe(false);
  });
  it('rejects when adding the next tile pushes past 400', () => {
    const result = wouldExceedRange(
      { x: 0, y: 0 },
      [{ x: 399, y: 0 }],
      { x: 401, y: 0 },
    );
    expect(result).toBe(true);
  });
  it('allows the first waypoint from origin within range', () => {
    expect(wouldExceedRange({ x: 0, y: 0 }, [], { x: 100, y: 0 })).toBe(false);
  });
  it('allows a path between the old round-trip cap (200) and the new one-way cap (400)', () => {
    // Old round-trip logic would have rejected 350 tiles; #117 path drones are one-way.
    expect(wouldExceedRange({ x: 0, y: 0 }, [{ x: 350, y: 0 }], { x: 350, y: 0 })).toBe(false);
    expect(wouldExceedRange({ x: 0, y: 0 }, [], { x: 350, y: 0 })).toBe(false);
  });
});

describe('fuelForPath', () => {
  it('returns 0 for an empty path', () => {
    expect(fuelForPath({ x: 0, y: 0 }, [])).toBe(0);
  });
  it('returns ceil(length / efficiency)', () => {
    // length 8 → 8 / 8 = 1 fuel
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 8, y: 0 }])).toBe(1);
    // length 9 → 9 / 8 = 1.125 → ceil → 2 fuel
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 9, y: 0 }])).toBe(2);
  });
  it('reports max fuel for the max-range path', () => {
    // length 400 → 400 / 8 = 50 = MAX_FUEL_PER_DRONE
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 400, y: 0 }])).toBe(MAX_FUEL_PER_DRONE);
  });
});

describe('popTrailingDuplicate', () => {
  it('returns input unchanged when length < 2', () => {
    const empty: ReadonlyArray<{ x: number; y: number }> = [];
    expect(popTrailingDuplicate(empty)).toBe(empty);
    const single = [{ x: 1, y: 1 }];
    expect(popTrailingDuplicate(single)).toBe(single);
  });
  it('pops the tail when last two waypoints are identical', () => {
    const result = popTrailingDuplicate([
      { x: 1, y: 1 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ]);
    expect(result).toEqual([{ x: 1, y: 1 }, { x: 5, y: 5 }]);
    expect(result.length).toBe(2);
  });
  it('returns input unchanged when last two waypoints differ', () => {
    const input = [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 6 }];
    expect(popTrailingDuplicate(input)).toBe(input);
  });
  it('only checks the tail, not other duplicates earlier in the path', () => {
    const input = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 9, y: 9 }];
    expect(popTrailingDuplicate(input)).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// Fix 6.6 — fuel-efficiency skill multiplier in T5 UI helpers
// ---------------------------------------------------------------------------

describe('Fix 6.6: wouldExceedRange and fuelForPath respect efficiencyMul', () => {
  // Base: MAX_FUEL_PER_DRONE=50, DRONE_T5_EFFICIENCY=8
  // Default mul=1: maxOneWay = 50 * 8 = 400 tiles

  it('wouldExceedRange with mul=2 doubles the allowed range', () => {
    // mul=2: maxOneWay = 50 * 8 * 2 = 800 tiles
    // A 700-tile path should be allowed with mul=2 but rejected with mul=1.
    const result = wouldExceedRange(
      { x: 0, y: 0 },
      [],
      { x: 700, y: 0 },
      2,
    );
    expect(result).toBe(false);

    // Same path without mul (default 1) should be rejected.
    const resultDefault = wouldExceedRange(
      { x: 0, y: 0 },
      [],
      { x: 700, y: 0 },
    );
    expect(resultDefault).toBe(true);
  });

  it('fuelForPath with mul=2 halves the fuel cost', () => {
    // path length=16, efficiency=DRONE_T5_EFFICIENCY * 2 = 16
    // fuel = ceil(16 / 16) = 1 (vs 2 without multiplier)
    const fuelWithMul = fuelForPath({ x: 0, y: 0 }, [{ x: 16, y: 0 }], 2);
    expect(fuelWithMul).toBe(1);

    const fuelNoMul = fuelForPath({ x: 0, y: 0 }, [{ x: 16, y: 0 }]);
    expect(fuelNoMul).toBe(2);
  });

  it('fuelForPath mul=1 (default) matches post-#117 one-way behavior', () => {
    // length 400 → 400 / 8 = 50 = MAX_FUEL_PER_DRONE
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 400, y: 0 }], 1)).toBe(MAX_FUEL_PER_DRONE);
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 400, y: 0 }])).toBe(MAX_FUEL_PER_DRONE);
  });

  it('wouldExceedRange mul=1 (default) matches post-#117 one-way behavior', () => {
    expect(wouldExceedRange({ x: 0, y: 0 }, [{ x: 399, y: 0 }], { x: 400, y: 0 }, 1)).toBe(false);
    expect(wouldExceedRange({ x: 0, y: 0 }, [{ x: 399, y: 0 }], { x: 400, y: 0 })).toBe(false);
    expect(wouldExceedRange({ x: 0, y: 0 }, [{ x: 399, y: 0 }], { x: 401, y: 0 }, 1)).toBe(true);
    expect(wouldExceedRange({ x: 0, y: 0 }, [{ x: 399, y: 0 }], { x: 401, y: 0 })).toBe(true);
  });
});
