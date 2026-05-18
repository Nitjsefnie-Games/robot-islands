// Pure day-night cycle math per SPEC §2.7.
//
// The world has a 24-real-hour cycle. Phase ∈ [0, 1) drives solar
// production via a true linear ramp through the dawn and dusk quadrants:
//
//   Dawn   phase [0.00, 0.25): mul linearly interpolates 0 → 1
//   Day    phase [0.25, 0.50): mul = 1.0
//   Dusk   phase [0.50, 0.75): mul linearly interpolates 1 → 0
//   Night  phase [0.75, 1.00): mul = 0.0
//
// To keep the §15.3 piecewise-constant-rate integrator faithful through the
// dawn / dusk ramps, those quadrants are sub-segmented into
// `SOLAR_RAMP_SEGMENTS` sub-boundaries. The economy loop's segment integrator
// queries `nextSolarBoundaryMs(t)` so each segment is bounded either by a
// quadrant transition OR by the next ramp sub-segment. The mul sampled at
// segment start is then used as a constant for that segment — same idiom as
// MAINTENANCE_RAMP_SEGMENTS in `maintenance.ts`.
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
 * Number of sub-segments each ramp quadrant (dawn, dusk) is divided into for
 * the §15.3 piecewise integration. The integrator samples
 * `solarMultiplier(t)` at the start of each segment and treats it as
 * constant within the segment; without sub-segmentation, a long dawn /
 * dusk segment would integrate at the start-of-segment multiplier (e.g.
 * 0 at dawn start) and miss the entire ramp. With N=8 sub-segments per
 * 6-hour quadrant, the worst-case integration error on a single segment
 * is bounded by `(quadrant_slope × segment_width) / 2`, i.e. `1/8/2 ≈ 6%`
 * of nameplate output per segment, which is well within the §15.3 noise
 * floor. Mirrors `MAINTENANCE_RAMP_SEGMENTS`.
 */
export const SOLAR_RAMP_SEGMENTS = 8;

/**
 * Solar-producer multiplier for the current phase. Linearly interpolates
 * 0 → 1 over Dawn, holds at 1.0 across Day, interpolates 1 → 0 over Dusk,
 * holds at 0.0 across Night. The integral over a full Dawn or Dusk quadrant
 * is exactly 0.5 — so long-window solar output preserves the prior
 * piecewise-constant model's quadrant total, only the in-window shape
 * differs.
 */
export function solarMultiplier(nowMs: number): number {
  const p = dayPhase(nowMs);
  if (p < 0.25) {
    // Dawn: position within the quadrant ∈ [0, 1) maps to mul ∈ [0, 1).
    return p / 0.25;
  }
  if (p < 0.5) {
    return 1.0;
  }
  if (p < 0.75) {
    // Dusk: position within the quadrant ∈ [0, 1) maps to mul = 1 - position.
    return 1.0 - (p - 0.5) / 0.25;
  }
  return 0.0;
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

/**
 * Wall-clock timestamp of the next moment `solarMultiplier` changes value
 * relative to its start-of-segment sample. Inside the flat Day / Night
 * quadrants this is the next quadrant boundary (mul jumps to / from a ramp
 * value at the boundary). Inside the ramped Dawn / Dusk quadrants this is
 * either the next sub-segment boundary (one of `SOLAR_RAMP_SEGMENTS` evenly
 * spaced ticks within the quadrant) or the quadrant end, whichever comes
 * first. Returns `null` only on the (defensive) edge case where no upcoming
 * boundary can be computed — defaults never fire this in normal play.
 *
 * The economy loop's segment integrator clamps each segment to this
 * boundary so the start-of-segment multiplier remains the constant rate
 * across the segment, per the §15.3 piecewise-constant-rate invariant.
 * Mirrors `nextMaintenanceBoundaryMs` in `maintenance.ts`.
 */
export function nextSolarBoundaryMs(nowMs: number): number | null {
  const p = dayPhase(nowMs);
  // Day (0.25-0.50) and Night (0.75-1.00) are flat; segment is bounded by
  // the next quadrant transition. Defer to nextPhaseBoundaryMs.
  if (p >= 0.25 && p < 0.5) return nextPhaseBoundaryMs(nowMs);
  if (p >= 0.75) return nextPhaseBoundaryMs(nowMs);
  // Dawn (0.00-0.25) or Dusk (0.50-0.75): sub-segment the quadrant.
  // Position within the quadrant in [0, 1).
  const quadStartPhase = p < 0.25 ? 0 : 0.5;
  const posInQuad = (p - quadStartPhase) / 0.25;
  // Width of one sub-segment in phase units within the quadrant.
  const subWidth = 1 / SOLAR_RAMP_SEGMENTS;
  // Next sub-segment index (1..SOLAR_RAMP_SEGMENTS). The last sub-boundary
  // lands exactly on the quadrant end.
  const nextSubIdx = Math.floor(posInQuad / subWidth) + 1;
  const nextPosInQuad = Math.min(nextSubIdx * subWidth, 1);
  const nextPhase = quadStartPhase + nextPosInQuad * 0.25;
  const phaseDelta = nextPhase - p;
  return nowMs + phaseDelta * DAY_DURATION_MS;
}
