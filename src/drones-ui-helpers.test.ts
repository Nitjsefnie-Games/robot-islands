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
  // Max one-way = MAX_FUEL × T5_EFF / 2 = 50 × 8 / 2 = 200 tiles
  it('allows a 199-tile path with one more 1-tile hop (200 exactly)', () => {
    const result = wouldExceedRange(
      { x: 0, y: 0 },
      [{ x: 199, y: 0 }],
      { x: 200, y: 0 },
    );
    expect(result).toBe(false);
  });
  it('rejects when adding the next tile pushes past 200', () => {
    const result = wouldExceedRange(
      { x: 0, y: 0 },
      [{ x: 199, y: 0 }],
      { x: 201, y: 0 },
    );
    expect(result).toBe(true);
  });
  it('allows the first waypoint from origin within range', () => {
    expect(wouldExceedRange({ x: 0, y: 0 }, [], { x: 100, y: 0 })).toBe(false);
  });
});

describe('fuelForPath', () => {
  it('returns 0 for an empty path', () => {
    expect(fuelForPath({ x: 0, y: 0 }, [])).toBe(0);
  });
  it('returns ceil(2 × length / efficiency)', () => {
    // length 8 → 2 × 8 = 16 / 8 = 2 fuel
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 8, y: 0 }])).toBe(2);
    // length 9 → 2 × 9 = 18 / 8 = 2.25 → ceil → 3 fuel
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 9, y: 0 }])).toBe(3);
  });
  it('reports max fuel for the max-range path', () => {
    // length 200 → 2 × 200 = 400 / 8 = 50 = MAX_FUEL_PER_DRONE
    expect(fuelForPath({ x: 0, y: 0 }, [{ x: 200, y: 0 }])).toBe(MAX_FUEL_PER_DRONE);
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
