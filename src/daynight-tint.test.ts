import { describe, expect, it } from 'vitest';

import { currentTint } from './daynight-tint.js';
import { DAY_DURATION_MS, dayPhase, dayPhaseName } from './daynight.js';

// Sample a midpoint of each non-night quadrant. Night is the only quadrant
// where the tint cleanly differs from day.
const MID_DAWN = -(DAY_DURATION_MS * 0.375) + DAY_DURATION_MS * 0.125; // phase 0.125
const MID_DAY = 0; // phase 0.375 — Day midpoint per EPOCH_PHASE_OFFSET
const MID_DUSK = -(DAY_DURATION_MS * 0.375) + DAY_DURATION_MS * 0.625; // phase 0.625
const MID_NIGHT = -(DAY_DURATION_MS * 0.375) + DAY_DURATION_MS * 0.875; // phase 0.875

describe('currentTint', () => {
  it('returns near-zero alpha in the middle of the Day quadrant', () => {
    expect(dayPhaseName(MID_DAY)).toBe('day');
    expect(currentTint(MID_DAY).alpha).toBe(0);
  });

  it('returns Night tint at Night midpoint', () => {
    expect(dayPhaseName(MID_NIGHT)).toBe('night');
    const t = currentTint(MID_NIGHT);
    expect(t.alpha).toBeGreaterThan(0.25);
    expect(t.alpha).toBeLessThan(0.4);
  });

  it('returns warmer Dawn tint at Dawn midpoint', () => {
    expect(dayPhaseName(MID_DAWN)).toBe('dawn');
    const t = currentTint(MID_DAWN);
    expect(t.alpha).toBeGreaterThan(0);
    expect(t.alpha).toBeLessThan(0.2);
  });

  it('returns Dusk tint at Dusk midpoint', () => {
    expect(dayPhaseName(MID_DUSK)).toBe('dusk');
    const t = currentTint(MID_DUSK);
    expect(t.alpha).toBeGreaterThan(0);
    expect(t.alpha).toBeLessThan(0.2);
  });

  it('crossfades alpha across the dusk→night boundary', () => {
    // Boundary at phase 0.75; alpha should rise monotonically toward Night's higher alpha.
    const boundaryMs = -(DAY_DURATION_MS * 0.375) + DAY_DURATION_MS * 0.75;
    const before = currentTint(boundaryMs - 2 * 60 * 1000);
    const at = currentTint(boundaryMs);
    const after = currentTint(boundaryMs + 2 * 60 * 1000);
    // Dusk alpha 0.12 < Night alpha 0.32, so we expect rising alpha.
    expect(before.alpha).toBeLessThan(after.alpha);
    expect(at.alpha).toBeGreaterThan(before.alpha);
    expect(at.alpha).toBeLessThan(after.alpha);
  });

  it('wraps the phase-0.0 boundary crossfade instead of clamping to full dawn', () => {
    // Boundary at phase 0.0 (night → dawn). A pre-boundary phase like 0.9966 is
    // inside the transition window and should be near full night, not full dawn.
    const boundaryMs = -(DAY_DURATION_MS * 0.375) + DAY_DURATION_MS * 0.0;
    const before = currentTint(boundaryMs - 5 * 60 * 1000); // ≈ window entry
    const at = currentTint(boundaryMs); // t = 0.5
    const after = currentTint(boundaryMs + 2 * 60 * 1000); // deeper into dawn side
    // Night alpha 0.32 > Dawn alpha 0.10, so alpha should fall through the window.
    expect(before.alpha).toBeCloseTo(0.32, 2);
    expect(at.alpha).toBeCloseTo(0.21, 2); // midpoint of 0.32 and 0.10
    expect(after.alpha).toBeLessThan(at.alpha);
  });

  it('matches expected phase identity at midpoints (sanity)', () => {
    expect(dayPhase(MID_DAWN)).toBeCloseTo(0.125, 5);
    expect(dayPhase(MID_DAY)).toBeCloseTo(0.375, 5);
    expect(dayPhase(MID_DUSK)).toBeCloseTo(0.625, 5);
    expect(dayPhase(MID_NIGHT)).toBeCloseTo(0.875, 5);
  });

  it('returns the night tint for a Brno night instant (real sun)', () => {
    const t = new Date('2026-05-29T00:30:00Z').getTime();
    const tint = currentTint(t, 49.20, 16.61);
    expect(tint.alpha).toBeCloseTo(0.32, 2);
  });

  it('returns the day tint for a Brno day instant (real sun)', () => {
    const t = new Date('2026-05-29T10:00:00Z').getTime();
    expect(currentTint(t, 49.20, 16.61).alpha).toBe(0);
  });

  it('still returns the synthetic result for a one-arg call (fallback guard)', () => {
    expect(currentTint(MID_DAY).alpha).toBe(0); // synthetic Day midpoint
  });
});
