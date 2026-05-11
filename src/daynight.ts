// Pure day-night cycle math per SPEC §2.7.
//
// The world has a 24-real-hour cycle. Phase ∈ [0, 1) drives solar
// production: Dawn 0.5×, Day 1.0×, Dusk 0.5×, Night 0.0×.
//
// Per the quadrant model, the multiplier is constant within each quadrant
// at the spec's stated time-average ("Dawn: 50% output (linear ramp 0→100)").
// The 50% IS the integral of the linear ramp over its 6-hour quadrant, so
// treating the quadrant as piecewise-constant keeps the event-driven
// integrator's piecewise-rate invariant intact AND gives the exact same
// 24-hour integral as the ramp model. Without piecewise-constant rates,
// `findNextCapEvent` would have to handle ramp segments.
//
// `dayPhase(0)` is offset so the test fixture's default `lastTick=0` lands
// in the Day quadrant (multiplier 1.0). The Unix epoch is not a meaningful
// in-game time; the offset is purely a calibration that lets pre-existing
// power-balance tests continue to expect full solar output at t=0.
//
// No PixiJS, no DOM. Pure deterministic functions.

/** 24 real hours expressed in milliseconds. */
export const DAY_DURATION_MS = 24 * 60 * 60 * 1000;

/** Length of one quadrant (6 real hours) in milliseconds. */
export const QUADRANT_MS = DAY_DURATION_MS / 4;

/** Phase offset applied to wall-clock time before taking the modulo. Chosen
 *  so `nowMs = 0` maps to phase 0.375 (mid-Day quadrant), giving the
 *  fixture-default `lastTick = 0` a solar multiplier of 1.0. */
const EPOCH_PHASE_OFFSET = 0.375;

/** Day phase identifier. Order matches the [0,1) sweep. */
export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';

/**
 * Continuous day-phase value in `[0, 1)`. `nowMs = 0` lands at 0.375 (Day).
 * Negative inputs handled — the double-modulo keeps the result in `[0, 1)`
 * for any finite input.
 */
export function dayPhase(nowMs: number): number {
  const raw = nowMs / DAY_DURATION_MS + EPOCH_PHASE_OFFSET;
  // (((x % 1) + 1) % 1) — JS `%` preserves sign of dividend; the `+1) % 1`
  // wraps negatives back into `[0, 1)`.
  return ((raw % 1) + 1) % 1;
}

/** Phase quadrant name at the given wall-clock time. */
export function dayPhaseName(nowMs: number): DayPhase {
  const p = dayPhase(nowMs);
  if (p < 0.25) return 'dawn';
  if (p < 0.5) return 'day';
  if (p < 0.75) return 'dusk';
  return 'night';
}

/**
 * Solar-producer multiplier for the current phase. Returns the spec's stated
 * time-average for each quadrant: Dawn/Dusk 0.5, Day 1.0, Night 0.0.
 */
export function solarMultiplier(nowMs: number): number {
  switch (dayPhaseName(nowMs)) {
    case 'dawn':
      return 0.5;
    case 'day':
      return 1.0;
    case 'dusk':
      return 0.5;
    case 'night':
      return 0.0;
  }
}

/**
 * Wall-clock timestamp of the next phase boundary strictly after `nowMs`.
 * The event-driven economy integrator uses this to bound a segment so the
 * solar multiplier stays constant across the segment — without this, a
 * multi-day offline catchup would integrate a single snapshot multiplier
 * across phase transitions and the inventory math would drift.
 */
export function nextPhaseBoundaryMs(nowMs: number): number {
  const p = dayPhase(nowMs);
  // Distance (in phase units) to the next quadrant boundary at 0.25/0.50/0.75/1.00.
  // `floor(p * 4) + 1` gives the next quadrant index 1..4 → boundary at idx/4.
  const nextBoundaryPhase = (Math.floor(p * 4) + 1) / 4;
  const phaseDelta = nextBoundaryPhase - p;
  // Convert phase units back to milliseconds. Add to `nowMs`.
  return nowMs + phaseDelta * DAY_DURATION_MS;
}
