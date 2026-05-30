// Antenna signal-range: pure-logic tests for radius table, range emission,
// and point-in-range union semantics.

import { describe, expect, it } from 'vitest';

import {
  ANTENNA_SIGNAL_RADII,
  computeSignalRanges,
  pointInSignalRange,
  isAntennaRedundant,
  REDUNDANT_SAMPLES,
  type SignalRange,
} from './antenna.js';
import type { IslandSpec } from './world.js';

function makeIslandSpec(over: Partial<IslandSpec>): IslandSpec {
  return {
    id: 'spec',
    name: 'spec',
    biome: 'plains',
    cx: 0,
    cy: 0,
    majorRadius: 5,
    minorRadius: 5,
    populated: true,
    discovered: true,
    buildings: [],
    modifiers: [],
    ...over,
  };
}

describe('ANTENNA_SIGNAL_RADII', () => {
  it('matches the documented placeholder values', () => {
    expect(ANTENNA_SIGNAL_RADII.antenna_t1).toBe(80);
    expect(ANTENNA_SIGNAL_RADII.antenna_t2).toBe(140);
    expect(ANTENNA_SIGNAL_RADII.antenna_t3).toBe(220);
    expect(ANTENNA_SIGNAL_RADII.antenna_t4).toBe(320);
    expect(ANTENNA_SIGNAL_RADII.antenna_t5).toBe(480);
    expect(ANTENNA_SIGNAL_RADII.antenna_t6).toBe(700);
  });
});

describe('computeSignalRanges', () => {
  it('emits one SignalRange per Antenna building on a populated island', () => {
    const spec = makeIslandSpec({
      cx: 10,
      cy: 20,
      buildings: [
        { id: 'a1', defId: 'antenna_t1', x: 0, y: 0 },
      ],
    });
    const ranges = computeSignalRanges([spec]);
    expect(ranges).toHaveLength(1);
    // 1×1 footprint at (0,0) on a (10,20) island → center at (10.5, 20.5).
    expect(ranges[0]!.cx).toBeCloseTo(10.5);
    expect(ranges[0]!.cy).toBeCloseTo(20.5);
    expect(ranges[0]!.radius).toBe(80);
  });

  it('returns empty when no antennas are placed', () => {
    const spec = makeIslandSpec({
      buildings: [
        { id: 'workshop-1', defId: 'workshop', x: 0, y: 0 },
      ],
    });
    expect(computeSignalRanges([spec])).toEqual([]);
  });

  it('returns empty when no islands are populated', () => {
    expect(computeSignalRanges([])).toEqual([]);
  });

  it('emits multiple SignalRanges from a single island', () => {
    const spec = makeIslandSpec({
      buildings: [
        { id: 'a1', defId: 'antenna_t1', x: 0, y: 0 },
        { id: 'a2', defId: 'antenna_t3', x: 2, y: 2 },
      ],
    });
    const ranges = computeSignalRanges([spec]);
    expect(ranges).toHaveLength(2);
    const radii = ranges.map((r) => r.radius).sort((a, b) => a - b);
    expect(radii).toEqual([80, 220]);
  });

  it('emits ranges from multiple populated islands', () => {
    const home = makeIslandSpec({
      id: 'home',
      cx: 0,
      cy: 0,
      buildings: [{ id: 'a1', defId: 'antenna_t1', x: 0, y: 0 }],
    });
    const colony = makeIslandSpec({
      id: 'colony',
      cx: 100,
      cy: 100,
      buildings: [{ id: 'a2', defId: 'antenna_t2', x: 0, y: 0 }],
    });
    const ranges = computeSignalRanges([home, colony]);
    expect(ranges).toHaveLength(2);
  });

  it('places 2x2 antenna center at offset+1.0 from corner', () => {
    const spec = makeIslandSpec({
      cx: 0,
      cy: 0,
      buildings: [
        { id: 'a1', defId: 'antenna_t4', x: 0, y: 0 }, // 2×2 footprint
      ],
    });
    const ranges = computeSignalRanges([spec]);
    expect(ranges).toHaveLength(1);
    expect(ranges[0]!.cx).toBeCloseTo(1);
    expect(ranges[0]!.cy).toBeCloseTo(1);
  });
});

describe('pointInSignalRange', () => {
  it('returns false against an empty range list', () => {
    expect(pointInSignalRange([], 0, 0)).toBe(false);
  });

  it('returns true at the center of a range', () => {
    expect(pointInSignalRange([{ cx: 10, cy: 20, radius: 5 }], 10, 20)).toBe(true);
  });

  it('returns true at the boundary (distance == radius)', () => {
    expect(pointInSignalRange([{ cx: 0, cy: 0, radius: 5 }], 5, 0)).toBe(true);
  });

  it('returns false outside the boundary', () => {
    expect(pointInSignalRange([{ cx: 0, cy: 0, radius: 5 }], 6, 0)).toBe(false);
  });

  it('unions multiple ranges — inside any one returns true', () => {
    const ranges = [
      { cx: 0, cy: 0, radius: 5 },
      { cx: 100, cy: 100, radius: 5 },
    ];
    expect(pointInSignalRange(ranges, 0, 0)).toBe(true);
    expect(pointInSignalRange(ranges, 100, 100)).toBe(true);
    expect(pointInSignalRange(ranges, 50, 50)).toBe(false);
  });
});

describe('isAntennaRedundant', () => {
  it('a lone antenna is never redundant', () => {
    const test: SignalRange = { cx: 0, cy: 0, radius: 80 };
    expect(isAntennaRedundant(test, [])).toBe(false);
  });

  it('an antenna fully inside one bigger antenna is redundant', () => {
    // test radius 50 centred at origin; other radius 200 also at origin → fully covers.
    const test: SignalRange = { cx: 0, cy: 0, radius: 50 };
    const others: SignalRange[] = [{ cx: 0, cy: 0, radius: 200 }];
    expect(isAntennaRedundant(test, others)).toBe(true);
  });

  it('two co-located identical antennas — each redundant relative to the other', () => {
    // closed-disc test: perimeter samples lie ON the other's perimeter → inside.
    const a: SignalRange = { cx: 0, cy: 0, radius: 80 };
    const b: SignalRange = { cx: 0, cy: 0, radius: 80 };
    expect(isAntennaRedundant(a, [b])).toBe(true);
    expect(isAntennaRedundant(b, [a])).toBe(true);
  });

  it('an antenna with a clearly-uncovered perimeter is not redundant', () => {
    // test centred at (0, 0) radius 100; the only "other" sits far to the right.
    // The test's left perimeter (~ x = -100) is nowhere near the other's disc.
    const test: SignalRange = { cx: 0, cy: 0, radius: 100 };
    const others: SignalRange[] = [{ cx: 500, cy: 0, radius: 50 }];
    expect(isAntennaRedundant(test, others)).toBe(false);
  });

  it('union of two flanking antennas covers a test neither one alone covers', () => {
    // test radius 80 at origin. Each "other" (r=100, offset ±40 on x) covers
    // only its half — the (40,0) disc misses the test's left perimeter
    // (point (-80,0) is dist 120 > 100), the (-40,0) disc misses the right.
    // Their UNION covers every perimeter sample. The test must return true
    // only if isAntennaRedundant uses the union (pointInSignalRange) and not
    // any single-other check.
    const test: SignalRange = { cx: 0, cy: 0, radius: 80 };
    const others: SignalRange[] = [
      { cx: 40, cy: 0, radius: 100 },
      { cx: -40, cy: 0, radius: 100 },
    ];
    expect(isAntennaRedundant(test, others)).toBe(true);
  });

  it('exports REDUNDANT_SAMPLES = 24', () => {
    expect(REDUNDANT_SAMPLES).toBe(24);
  });
});
