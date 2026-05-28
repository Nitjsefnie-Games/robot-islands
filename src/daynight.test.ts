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
    // lands in the Day quadrant.
    expect(dayPhaseName(0)).toBe('day');
    // solarMultiplier uses real astronomy; Date(0) at (0,0) is midnight,
    // so use a known noon for the full-solar fixture.
    const noon = new Date('2026-03-20T12:00:00Z').getTime();
    expect(solarMultiplier(noon, 0, 0)).toBeCloseTo(1.0, 2);
  });
});

describe('solarMultiplier — astronomy', () => {
  it('returns ~1.0 at equator noon on the spring equinox', () => {
    const t = new Date('2026-03-20T12:00:00Z').getTime();
    expect(solarMultiplier(t, 0, 0)).toBeCloseTo(1.0, 2);
  });

  it('returns ~0.80 at 60°N noon on June solstice', () => {
    const t = new Date('2026-06-21T12:00:00Z').getTime();
    expect(solarMultiplier(t, 60, 0)).toBeCloseTo(0.80, 1);
  });

  it('returns ~0.10 at 60°N noon on December solstice', () => {
    const t = new Date('2026-12-21T12:00:00Z').getTime();
    expect(solarMultiplier(t, 60, 0)).toBeCloseTo(0.10, 1);
  });

  it('returns 0 throughout polar night at 84°N on Dec 21', () => {
    const dec21 = new Date('2026-12-21T00:00:00Z').getTime();
    for (let h = 0; h < 24; h++) {
      const t = dec21 + h * 60 * 60 * 1000;
      expect(solarMultiplier(t, 84, 0)).toBe(0);
    }
  });

  it('is monotonic ascending across a sunrise transition', () => {
    // At (40.7128, -74.0060) on Mar 20, sun rises around 11:05 UTC.
    const base = new Date('2026-03-20T11:00:00Z').getTime();
    let prev = -1;
    for (let m = 0; m <= 120; m++) {
      const t = base + m * 60 * 1000;
      const mul = solarMultiplier(t, 40.7128, -74.0060);
      expect(mul).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = mul;
    }
  });
});

describe('solarMultiplier — null inputs', () => {
  it.each([
    [0],
    [new Date('2026-06-21T12:00:00Z').getTime()],
    [new Date('2026-12-21T00:00:00Z').getTime()],
  ])('returns 0 at t=%s regardless of nowMs', (t) => {
    expect(solarMultiplier(t, null, null)).toBe(0);
    expect(solarMultiplier(t, 0, null)).toBe(0);
    expect(solarMultiplier(t, null, 0)).toBe(0);
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
  const SEGMENT_MS = DAY_DURATION_MS / (SOLAR_RAMP_SEGMENTS * 4);

  it('returns the next segment boundary at t = 0', () => {
    const b = nextSolarBoundaryMs(0);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(SEGMENT_MS, 6);
  });

  it('returns the next segment boundary inside a segment', () => {
    const t = SEGMENT_MS / 2;
    const b = nextSolarBoundaryMs(t);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(SEGMENT_MS, 6);
  });

  it('returns the next segment boundary at the start of a segment', () => {
    const t = SEGMENT_MS * 5;
    const b = nextSolarBoundaryMs(t);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(SEGMENT_MS * 6, 6);
  });

  it('gap is exactly one segment width', () => {
    for (const t of [0, SEGMENT_MS * 3, SEGMENT_MS * 10, SEGMENT_MS * 31]) {
      const b = nextSolarBoundaryMs(t);
      expect(b).not.toBeNull();
      expect(b! - t).toBeCloseTo(SEGMENT_MS, 6);
    }
  });

  it('wraps cleanly across day boundary', () => {
    const lastSegmentStart = SEGMENT_MS * 31;
    const b = nextSolarBoundaryMs(lastSegmentStart);
    expect(b).not.toBeNull();
    expect(b!).toBeCloseTo(SEGMENT_MS * 32, 6);
  });

  it('is strictly greater than nowMs for samples across the day', () => {
    for (const t of [0, SEGMENT_MS, SEGMENT_MS * 8, SEGMENT_MS * 16, SEGMENT_MS * 24, SEGMENT_MS * 31]) {
      const b = nextSolarBoundaryMs(t);
      expect(b).not.toBeNull();
      expect(b!).toBeGreaterThan(t);
    }
  });
});
