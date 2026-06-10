// §9.9 Active-Play Production Bonus — pure accrual/decay math.
//
// One unified rule: focused frame-dt accrues (clamped to ONLINE_DT_CAP_MS,
// the same clamp trade.ts uses so a gap can't dump time); every OTHER
// wall-clock millisecond decays the balance at ACTIVE_DECAY_RATIO×. The
// balance `activeBonusMs` is "effective focused milliseconds"; the derived
// recipe-rate multiplier is
//   1 + (activeBonusMs / 60_000) × ACTIVE_BONUS_PER_MIN
// i.e. +0.1% per focused minute, −0.3%/min away, floor 0, no cap (§9.9).
//
// The same rule covers every loss mode: a blurred-but-visible frame decays
// its full dt; a hidden-tab gap arrives as one large frameDt on the refocus
// frame (accrual clamps, the rest decays); a closed-game gap is charged at
// load by persistence.ts from the snapshot's savedAt.
//
// Pure layer: no PixiJS, no DOM. The caller supplies the online boolean
// (document.visibilityState === 'visible' — computed in main.ts's ticker,
// shared with the trade lifecycle; hasFocus() dropped per owner request 2026-06-10).

import { ONLINE_DT_CAP_MS } from './trade.js';

/** +0.1% recipe rate per focused minute (§9.9). */
export const ACTIVE_BONUS_PER_MIN = 0.001;

/** Unfocused wall-clock burns the balance at 3× the accrual rate
 *  (−0.3%/min). Also applied to closed-game gaps at load. */
export const ACTIVE_DECAY_RATIO = 3;

/** Minimal structural slice of WorldState this module touches — keeps the
 *  module decoupled and trivially testable. Optional field for legacy-save
 *  and test-fixture back-compat (same pattern as WorldState.tutorialState). */
export interface ActiveBonusCarrier {
  activeBonusMs?: number;
}

/** Advance the balance by one wall-clock interval of `frameDtMs`. `online` =
 *  tab visible AND focused. Accrual is clamped to ONLINE_DT_CAP_MS per call;
 *  the unaccrued remainder of the interval decays at ACTIVE_DECAY_RATIO×.
 *  Mutates `world.activeBonusMs`; no-op on non-positive dt. */
export function tickActiveBonus(
  world: ActiveBonusCarrier,
  online: boolean,
  frameDtMs: number,
): void {
  if (!(frameDtMs > 0)) return;
  const accrued = online ? Math.min(frameDtMs, ONLINE_DT_CAP_MS) : 0;
  const next =
    (world.activeBonusMs ?? 0) + accrued - ACTIVE_DECAY_RATIO * (frameDtMs - accrued);
  world.activeBonusMs = next > 0 ? next : 0;
}

/** Recipe-rate multiplier derived from the balance. ≥ 1, uncapped. */
export function activeBonusMul(world: ActiveBonusCarrier): number {
  return 1 + ((world.activeBonusMs ?? 0) / 60_000) * ACTIVE_BONUS_PER_MIN;
}
