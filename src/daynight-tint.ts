// §2.7 day-night visual tint. A fixed-position full-viewport DIV overlaid
// on the canvas, pointer-events: none, alpha + color blended per phase:
//
//   dawn  → warm orange,  alpha 0.10
//   day   → transparent
//   dusk  → warm red,     alpha 0.12
//   night → cool dark blue, alpha 0.32
//
// Day phase boundaries are sharp in the pure math (§2.7 quadrant model),
// but the tint cross-fades within a transition window at each boundary so
// the world doesn't pop. A 10-minute (real-time) crossfade window reads
// smoothly during normal play and is invisible during offline catchup
// (which integrates entire phases at a time).

import { CIVIL_TWILIGHT_RAD, DAY_DURATION_MS, dayPhase, realPhaseName, solarAltitude } from './daynight.js';

const TRANSITION_MS = 10 * 60 * 1000;

interface PhaseTint {
  readonly color: string;
  readonly alpha: number;
}

const PHASE_TINT: Record<'dawn' | 'day' | 'dusk' | 'night', PhaseTint> = {
  dawn: { color: '#ff9050', alpha: 0.10 },
  day: { color: '#ffffff', alpha: 0.0 },
  dusk: { color: '#ff5040', alpha: 0.12 },
  night: { color: '#1020a0', alpha: 0.32 },
};

const PHASE_BOUNDARIES: ReadonlyArray<{ phase: number; from: keyof typeof PHASE_TINT; to: keyof typeof PHASE_TINT }> = [
  { phase: 0.0, from: 'night', to: 'dawn' },
  { phase: 0.25, from: 'dawn', to: 'day' },
  { phase: 0.5, from: 'day', to: 'dusk' },
  { phase: 0.75, from: 'dusk', to: 'night' },
];

function blend(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function blendTints(a: PhaseTint, b: PhaseTint, t: number): PhaseTint {
  const [ar, ag, ab] = hexToRgb(a.color);
  const [br, bg, bb] = hexToRgb(b.color);
  const r = Math.round(blend(ar, br, t));
  const g = Math.round(blend(ag, bg, t));
  const bv = Math.round(blend(ab, bb, t));
  const alpha = blend(a.alpha, b.alpha, t);
  return { color: `rgb(${r},${g},${bv})`, alpha };
}

/** ±2° altitude cross-fade half-window around the h=0 and h=-6° boundaries. */
const TINT_FADE_RAD = (2 * Math.PI) / 180;

/** Pure helper: the tint to apply at `nowMs`. With lat/lon it follows the real
 *  sun (altitude-driven cross-fades at the h=0 and h=-6° boundaries); with null
 *  lat/lon it falls back to the synthetic-quadrant tint. Exported for unit
 *  testing — the DOM-write side is mountDayNightTint below. */
export function currentTint(
  nowMs: number,
  lat: number | null = null,
  lon: number | null = null,
): PhaseTint {
  const h = solarAltitude(nowMs, lat, lon);
  if (h == null) return syntheticTint(nowMs);
  // Twilight tint: rising → dawn, falling → dusk (lat/lon non-null here).
  const hNext = solarAltitude(nowMs + 60_000, lat, lon)!;
  const twilight = hNext > h ? PHASE_TINT.dawn : PHASE_TINT.dusk;
  // Cross-fade near h = 0 (twilight ↔ day).
  if (Math.abs(h) <= TINT_FADE_RAD) {
    const t = Math.min(1, Math.max(0, (h + TINT_FADE_RAD) / (2 * TINT_FADE_RAD)));
    return blendTints(twilight, PHASE_TINT.day, t);
  }
  // Cross-fade near h = -6° (night ↔ twilight).
  if (Math.abs(h - CIVIL_TWILIGHT_RAD) <= TINT_FADE_RAD) {
    const t = Math.min(1, Math.max(0, (h - (CIVIL_TWILIGHT_RAD - TINT_FADE_RAD)) / (2 * TINT_FADE_RAD)));
    return blendTints(PHASE_TINT.night, twilight, t);
  }
  return PHASE_TINT[realPhaseName(nowMs, lat, lon)];
}

/** Synthetic-quadrant tint — the pre-real-sun behaviour, retained as the
 *  null-location fallback. */
function syntheticTint(nowMs: number): PhaseTint {
  const p = dayPhase(nowMs);
  const phaseWidth = TRANSITION_MS / DAY_DURATION_MS;
  for (const b of PHASE_BOUNDARIES) {
    const dist = Math.abs(p - b.phase);
    const wrapDist = Math.min(dist, 1 - dist);
    if (wrapDist <= phaseWidth / 2) {
      // Within the cross-fade window. Compute t in [0, 1] across the window.
      const start = b.phase - phaseWidth / 2;
      let pp = p - start;
      if (pp < 0) pp += 1;
      const t = Math.min(1, Math.max(0, pp / phaseWidth));
      return blendTints(PHASE_TINT[b.from], PHASE_TINT[b.to], t);
    }
  }
  // Not in any transition — pick the quadrant's tint.
  if (p < 0.25) return PHASE_TINT.dawn;
  if (p < 0.5) return PHASE_TINT.day;
  if (p < 0.75) return PHASE_TINT.dusk;
  return PHASE_TINT.night;
}

export interface DayNightTintHandle {
  refresh(nowMs: number, lat?: number | null, lon?: number | null): void;
  /** Test/debug seam — exposes the tint DOM element for assertions. */
  readonly el: HTMLDivElement;
}

export function mountDayNightTint(parentEl: HTMLElement): DayNightTintHandle {
  const el = document.createElement('div');
  el.id = 'daynight-tint';
  el.style.cssText = `
    position: fixed;
    inset: 0;
    pointer-events: none;
    background: transparent;
    opacity: 0;
    mix-blend-mode: multiply;
    z-index: 100;
    transition: background-color 200ms linear, opacity 200ms linear;
  `;
  parentEl.appendChild(el);
  let last: PhaseTint | null = null;
  return {
    el,
    refresh(nowMs: number, lat: number | null = null, lon: number | null = null): void {
      const tint = currentTint(nowMs, lat, lon);
      if (last && Math.abs(last.alpha - tint.alpha) < 0.005 && last.color === tint.color) {
        return;
      }
      el.style.backgroundColor = tint.color;
      el.style.opacity = String(tint.alpha);
      last = tint;
    },
  };
}
