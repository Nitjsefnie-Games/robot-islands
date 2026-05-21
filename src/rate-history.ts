// Rolling-average rate history — shared by the inventory panel (inventory-ui.ts)
// and the HUD output-rates section (hud.ts). Pure layer: no PixiJS, no DOM.
//
// The instantaneous economy `net` rate steps abruptly whenever a recipe caps
// or stalls. These helpers turn a buffer of timestamped inventory snapshots
// into the average REALIZED rate over a rolling window — smooth, and ~0 for a
// cap-pinned resource (unlike a time-average of the claimed rate).

import { inv, type IslandState } from './economy.js';
import { ALL_RESOURCES, type ResourceId } from './recipes.js';

/** Rolling-average window for the rate display, in milliseconds. */
export const RATE_WINDOW_MS = 60000;

/** Minimum sample span before a rate is reported. Below this, `averageRate`
 *  returns an empty record (rendered as `·`) — avoids a divide-by-near-zero
 *  single-frame spike during warm-up. */
export const RATE_MIN_SPAN_MS = 250;

/** One timestamped inventory snapshot. `t` is a `performance.now()` reading;
 *  `inv` is a COPY of the island's inventory at that instant (the live
 *  `IslandState.inventory` is mutated in place, so a reference is useless). */
export interface RateSample {
  readonly t: number;
  readonly inv: Record<ResourceId, number>;
}

/**
 * Average per-resource rate (units/sec) over a buffered window.
 *
 * `buffer` is oldest-first and includes the current frame as its last entry.
 * The rate is `(newest − oldest) / span` per resource. Returns an empty
 * record when there are fewer than 2 samples or the span is under
 * `RATE_MIN_SPAN_MS` — callers read missing keys as 0.
 *
 * Because it measures realized stock deltas, a cap-pinned resource reads ~0
 * even while the economy still reports a non-zero instantaneous rate.
 */
export function averageRate(
  buffer: readonly RateSample[],
): Record<ResourceId, number> {
  const out = {} as Record<ResourceId, number>;
  if (buffer.length < 2) return out;
  const oldest = buffer[0];
  const newest = buffer[buffer.length - 1];
  if (!oldest || !newest) return out;
  const spanMs = newest.t - oldest.t;
  if (spanMs < RATE_MIN_SPAN_MS) return out;
  const spanSec = spanMs / 1000;
  for (const r of ALL_RESOURCES) {
    const delta = (newest.inv[r] ?? 0) - (oldest.inv[r] ?? 0);
    out[r] = delta / spanSec;
  }
  return out;
}

/**
 * Drop samples that fall outside the `RATE_WINDOW_MS` window ending at `now`,
 * mutating `buffer` in place. One sample just past the window edge is kept so
 * the average spans a full window. Never prunes below 2 samples.
 */
export function pruneRateBuffer(buffer: RateSample[], now: number): void {
  const cutoff = now - RATE_WINDOW_MS;
  while (buffer.length >= 3) {
    const second = buffer[1];
    if (!second || second.t >= cutoff) break;
    buffer.shift();
  }
}

/** Copy an island's inventory into a plain record — one snapshot for a
 *  rate buffer. */
export function snapshotInventory(state: IslandState): Record<ResourceId, number> {
  const snap = {} as Record<ResourceId, number>;
  for (const r of ALL_RESOURCES) snap[r] = inv(state, r);
  return snap;
}
