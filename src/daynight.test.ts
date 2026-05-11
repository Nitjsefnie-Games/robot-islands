// Pure-math tests for the §2.7 day-night cycle.

import { describe, expect, it } from 'vitest';

import {
  DAY_DURATION_MS,
  QUADRANT_MS,
  dayPhase,
  dayPhaseName,
  nextPhaseBoundaryMs,
  solarMultiplier,
} from './daynight.js';

describe('dayPhase', () => {
  it('wraps cleanly over a full day', () => {
    const at0 = dayPhase(0);
    expect(dayPhase(DAY_DURATION_MS)).toBeCloseTo(at0, 9);
    expect(dayPhase(2 * DAY_DURATION_MS)).toBeCloseTo(at0, 9);
  });

  it('phase advances by 0.5 over a half day', () => {
    const at0 = dayPhase(0);
    const half = dayPhase(0.5 * DAY_DURATION_MS);
    // Wrap-aware difference.
    const diff = ((half - at0) % 1 + 1) % 1;
    expect(diff).toBeCloseTo(0.5, 9);
  });

  it('returns a value in [0, 1) for any finite input', () => {
    for (const t of [-1e10, -1, 0, 1, 1e10, 12345.6789, DAY_DURATION_MS * 7.3]) {
      const p = dayPhase(t);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('handles negative nowMs (modulo wraps correctly)', () => {
    const at0 = dayPhase(0);
    expect(dayPhase(-DAY_DURATION_MS)).toBeCloseTo(at0, 9);
    expect(dayPhase(-2 * DAY_DURATION_MS)).toBeCloseTo(at0, 9);
    // Half-day earlier ≡ half-day later modulo 1.
    const halfEarlier = dayPhase(-0.5 * DAY_DURATION_MS);
    const halfLater = dayPhase(0.5 * DAY_DURATION_MS);
    expect(halfEarlier).toBeCloseTo(halfLater, 9);
  });

  it('nowMs=0 lands in the Day quadrant (fixture-default alignment)', () => {
    // The epoch phase offset is calibrated so fixture-default `lastTick=0`
    // lands at full solar (multiplier 1.0), keeping pre-existing
    // power-balance tests passing.
    expect(dayPhaseName(0)).toBe('day');
    expect(solarMultiplier(0)).toBe(1.0);
  });
});

describe('solarMultiplier + dayPhaseName per quadrant', () => {
  // Anchor: nowMs=0 is phase 0.375 (Day, multiplier 1.0). Quadrant boundaries
  // relative to nowMs=0 (one DAY_DURATION_MS = 24h, one quadrant = 6h):
  //   Dawn  phase [0.00, 0.25) — t/day ∈ [-0.375, -0.125) → t ∈ [-9h, -3h)
  //   Day   phase [0.25, 0.50) — t/day ∈ [-0.125, +0.125) → t ∈ [-3h, +3h)
  //   Dusk  phase [0.50, 0.75) — t/day ∈ [+0.125, +0.375) → t ∈ [+3h, +9h)
  //   Night phase [0.75, 1.00) — t/day ∈ [+0.375, +0.625) → t ∈ [+9h, +15h)
  const HOUR = 60 * 60 * 1000;
  const cases: ReadonlyArray<{ t: number; name: string; mul: number }> = [
    { t: -6 * HOUR, name: 'dawn', mul: 0.5 },
    { t: 0, name: 'day', mul: 1.0 },
    { t: 6 * HOUR, name: 'dusk', mul: 0.5 },
    { t: 12 * HOUR, name: 'night', mul: 0.0 },
  ];
  for (const c of cases) {
    it(`t=${c.t / HOUR}h → ${c.name} (mul ${c.mul})`, () => {
      expect(dayPhaseName(c.t)).toBe(c.name);
      expect(solarMultiplier(c.t)).toBe(c.mul);
    });
  }
});

describe('nextPhaseBoundaryMs', () => {
  it('is strictly greater than nowMs', () => {
    for (const t of [0, 1, 1234, DAY_DURATION_MS * 3.7, -1234]) {
      expect(nextPhaseBoundaryMs(t)).toBeGreaterThan(t);
    }
  });

  it('lands exactly on the next quadrant boundary', () => {
    // After the boundary, phase % 0.25 should be 0.
    for (const t of [0, 1234, DAY_DURATION_MS * 3.7, -1234]) {
      const b = nextPhaseBoundaryMs(t);
      const phaseAtBoundary = dayPhase(b);
      // Distance to nearest quadrant boundary (0, 0.25, 0.5, 0.75) in phase units.
      const fromQuad = Math.min(
        phaseAtBoundary,
        Math.abs(phaseAtBoundary - 0.25),
        Math.abs(phaseAtBoundary - 0.5),
        Math.abs(phaseAtBoundary - 0.75),
        1 - phaseAtBoundary,
      );
      expect(fromQuad).toBeLessThan(1e-9);
    }
  });

  it('the gap is at most one quadrant (6h)', () => {
    for (const t of [0, 1234, DAY_DURATION_MS * 3.7, -1234]) {
      const b = nextPhaseBoundaryMs(t);
      expect(b - t).toBeGreaterThan(0);
      expect(b - t).toBeLessThanOrEqual(QUADRANT_MS + 1);
    }
  });

  it('phase quadrant flips across the boundary', () => {
    // Test at nowMs=0 (Day) → boundary should land at start of Dusk.
    const b = nextPhaseBoundaryMs(0);
    // A tiny step past the boundary lands in Dusk.
    expect(dayPhaseName(b + 1)).toBe('dusk');
  });
});
