// Pure-math tests for the §2.7 day-night cycle.

import { describe, expect, it } from 'vitest';

import {
  DAY_DURATION_MS,
  QUADRANT_MS,
  SOLAR_RAMP_SEGMENTS,
  dayPhase,
  dayPhaseName,
  nextPhaseBoundaryMs,
  nextSolarBoundaryMs,
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
    expect(solarMultiplier(0, 0, 0)).toBe(1.0);
  });
});

describe('solarMultiplier + dayPhaseName per quadrant', () => {
  // Anchor: nowMs=0 is phase 0.375 (Day, multiplier 1.0). Quadrant boundaries
  // relative to nowMs=0 (one DAY_DURATION_MS = 24h, one quadrant = 6h):
  //   Dawn  phase [0.00, 0.25) — t/day ∈ [-0.375, -0.125) → t ∈ [-9h, -3h)
  //   Day   phase [0.25, 0.50) — t/day ∈ [-0.125, +0.125) → t ∈ [-3h, +3h)
  //   Dusk  phase [0.50, 0.75) — t/day ∈ [+0.125, +0.375) → t ∈ [+3h, +9h)
  //   Night phase [0.75, 1.00) — t/day ∈ [+0.375, +0.625) → t ∈ [+9h, +15h)
  //
  // Under the §2.7 linear-ramp model:
  //   Dawn quadrant: midpoint mul = 0.5, start = 0, end (just-before-Day) ≈ 1
  //   Day quadrant: 1.0 throughout
  //   Dusk quadrant: midpoint mul = 0.5, start = 1, end (just-before-Night) ≈ 0
  //   Night quadrant: 0.0 throughout
  const HOUR = 60 * 60 * 1000;

  it('quadrant names align with t-anchors', () => {
    expect(dayPhaseName(-6 * HOUR)).toBe('dawn');
    expect(dayPhaseName(0)).toBe('day');
    expect(dayPhaseName(6 * HOUR)).toBe('dusk');
    expect(dayPhaseName(12 * HOUR)).toBe('night');
  });

  it('Dawn: start=0, midpoint=0.5, just-before-end≈1', () => {
    // Dawn quadrant t ∈ [-9h, -3h). Midpoint t = -6h.
    expect(solarMultiplier(-9 * HOUR, 0, 0)).toBeCloseTo(0, 9);
    expect(solarMultiplier(-6 * HOUR, 0, 0)).toBeCloseTo(0.5, 9);
    expect(solarMultiplier(-3 * HOUR - 1, 0, 0)).toBeGreaterThan(0.999);
  });

  it('Day: flat 1.0 across the quadrant', () => {
    expect(solarMultiplier(-3 * HOUR, 0, 0)).toBe(1.0);
    expect(solarMultiplier(0, 0, 0)).toBe(1.0);
    expect(solarMultiplier(3 * HOUR - 1, 0, 0)).toBe(1.0);
  });

  it('Dusk: start=1, midpoint=0.5, just-before-end≈0', () => {
    // Dusk quadrant t ∈ [+3h, +9h). Midpoint t = +6h.
    expect(solarMultiplier(3 * HOUR, 0, 0)).toBe(1.0);
    expect(solarMultiplier(6 * HOUR, 0, 0)).toBeCloseTo(0.5, 9);
    expect(solarMultiplier(9 * HOUR - 1, 0, 0)).toBeLessThan(0.001);
  });

  it('Night: flat 0.0 across the quadrant', () => {
    expect(solarMultiplier(9 * HOUR, 0, 0)).toBe(0.0);
    expect(solarMultiplier(12 * HOUR, 0, 0)).toBe(0.0);
    expect(solarMultiplier(15 * HOUR - 1, 0, 0)).toBe(0.0);
  });

  it('is continuous: no jump > 1/SOLAR_RAMP_SEGMENTS between 1ms-apart samples inside Dawn/Dusk', () => {
    // Snap-detector. Per quadrant (6h = 21,600,000 ms), 1ms phase change is
    // ~4.6e-8, so mul change ≤ 4.6e-8 — well below the 1/8 = 0.125 bound.
    // Catches any reintroduction of piecewise-constant logic mid-quadrant.
    const maxAllowedJump = 1 / SOLAR_RAMP_SEGMENTS;
    // Sample 1000 points inside the dawn quadrant and 1000 inside dusk.
    for (const quadStart of [-9 * HOUR, 3 * HOUR]) {
      for (let i = 0; i < 1000; i++) {
        const t = quadStart + Math.floor((i / 1000) * QUADRANT_MS);
        // Stay strictly inside the quadrant (avoid the boundary, which IS
        // continuous in the ramp model but the next ms is in a different
        // quadrant).
        if (t + 1 >= quadStart + QUADRANT_MS) continue;
        const a = solarMultiplier(t, 0, 0);
        const b = solarMultiplier(t + 1, 0, 0);
        expect(Math.abs(b - a)).toBeLessThan(maxAllowedJump);
      }
    }
  });
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

describe('nextSolarBoundaryMs', () => {
  const HOUR = 60 * 60 * 1000;

  it('inside Day: returns next quadrant boundary (start of Dusk)', () => {
    // t=0 is mid-Day. Multiplier is constant 1.0 throughout Day, so the next
    // moment the value changes is the Day→Dusk transition at t = 3h.
    const b = nextSolarBoundaryMs(0);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(3 * HOUR, 9);
  });

  it('inside Night: returns next quadrant boundary (start of Dawn)', () => {
    // t=12h is mid-Night. Multiplier is constant 0.0 throughout Night, so the
    // next moment the value changes is the Night→Dawn transition at t = 15h.
    const b = nextSolarBoundaryMs(12 * HOUR);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(15 * HOUR, 9);
  });

  it('at Dawn start: next boundary lands (quadrant_ms / N) into the quadrant', () => {
    // Dawn starts at t = -9h (phase 0). Sub-segment width is QUADRANT_MS/N.
    const dawnStart = -9 * HOUR;
    const b = nextSolarBoundaryMs(dawnStart);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(dawnStart + QUADRANT_MS / SOLAR_RAMP_SEGMENTS, 6);
  });

  it('at Dawn quadrant midpoint: next boundary is the (5/N)-th sub-segment', () => {
    // Dawn midpoint = -6h. Position within quadrant = 0.5 = 4/8. Next sub-
    // boundary is at index 5 → (5/8) of the quadrant from dawn start.
    const dawnStart = -9 * HOUR;
    const t = -6 * HOUR;
    const b = nextSolarBoundaryMs(t);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(dawnStart + (5 * QUADRANT_MS) / SOLAR_RAMP_SEGMENTS, 6);
  });

  it('at Dusk start: next boundary lands (quadrant_ms / N) into the quadrant', () => {
    const duskStart = 3 * HOUR;
    const b = nextSolarBoundaryMs(duskStart);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(duskStart + QUADRANT_MS / SOLAR_RAMP_SEGMENTS, 6);
  });

  it('last sub-segment of Dawn ends exactly on Dawn→Day boundary', () => {
    // One ms before the last sub-boundary, the function should return the
    // quadrant-end timestamp (clamped, not overshooting into Day).
    const dawnStart = -9 * HOUR;
    const lastSubStart = dawnStart + ((SOLAR_RAMP_SEGMENTS - 1) * QUADRANT_MS) / SOLAR_RAMP_SEGMENTS;
    const b = nextSolarBoundaryMs(lastSubStart);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(dawnStart + QUADRANT_MS, 6);
  });

  it('is strictly greater than nowMs for samples across all quadrants', () => {
    for (const t of [-9 * HOUR, -6 * HOUR, 0, 3 * HOUR, 6 * HOUR, 12 * HOUR, 15 * HOUR]) {
      const b = nextSolarBoundaryMs(t);
      expect(b).not.toBeNull();
      expect(b!).toBeGreaterThan(t);
    }
  });
});
