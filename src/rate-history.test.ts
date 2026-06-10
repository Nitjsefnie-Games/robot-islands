// Tests for the rolling-average rate-history buffer (rate-history.ts).
//
// Focus: pruneRateBuffer's window discipline. Steady-state behavior keeps
// exactly ONE sample past the window edge (so the average spans a full
// window); the fix-3.8 regression covers the long-rAF-gap case, where the
// pre-gap head used to survive ~RATE_WINDOW_MS after refocus and dilute
// `averageRate` toward 0 (HUD showed near-zero rates after refocus).

import { describe, expect, it } from 'vitest';

import {
  averageRate,
  pruneRateBuffer,
  RATE_WINDOW_MS,
  type RateSample,
} from './rate-history.js';
import type { ResourceId } from './recipes.js';

function sample(t: number, ironOre: number): RateSample {
  return { t, inv: { iron_ore: ironOre } as Record<ResourceId, number> };
}

describe('pruneRateBuffer', () => {
  it('steady-state keeps exactly one past-edge sample', () => {
    // Samples every 5s spanning past the window. cutoff = now - 60s = 10s:
    // 0s and 5s are past the edge; the 0s sample is pruned, the 5s sample
    // is the single retained past-edge anchor.
    const buffer: RateSample[] = [];
    for (let t = 0; t <= 70_000; t += 5_000) buffer.push(sample(t, t / 1000));
    pruneRateBuffer(buffer, 70_000);
    expect(buffer[0]?.t).toBe(5_000);
    expect(buffer[1]?.t).toBe(10_000);
  });

  it('never prunes below 2 samples', () => {
    const buffer: RateSample[] = [sample(0, 0), sample(3 * 3600 * 1000, 10)];
    pruneRateBuffer(buffer, 3 * 3600 * 1000);
    expect(buffer.length).toBe(2);
  });

  it('drops an hours-old pre-gap head once fresh samples exist (fix 3.8)', () => {
    // Long rAF gap: head at t=0, then the tab refocuses hours later and two
    // fresh samples land. The head is the only past-edge sample, so the
    // steady-state rule kept it — but it is HOURS past the edge, not one
    // frame past, and dilutes the average for the next RATE_WINDOW_MS.
    const H = 3 * 3600 * 1000;
    const buffer: RateSample[] = [
      sample(0, 0), // pre-gap
      sample(H, 1000),
      sample(H + 1_000, 1001),
    ];
    pruneRateBuffer(buffer, H + 1_000);
    expect(buffer.length).toBe(2);
    expect(buffer[0]?.t).toBe(H);
    // With the stale head gone, the average reflects the realized post-gap
    // rate (1 unit/sec), not the gap-diluted ~0.093/sec.
    const rate = averageRate(buffer);
    expect(rate.iron_ore).toBeCloseTo(1, 6);
  });

  it('keeps a stale head while fewer than 2 in-window samples remain', () => {
    // Only ONE post-gap sample so far: dropping the head would leave a
    // single sample (averageRate returns {}). The stale head must survive
    // this frame and be dropped on the next one.
    const H = 3 * 3600 * 1000;
    const buffer: RateSample[] = [sample(0, 0), sample(H, 1000)];
    pruneRateBuffer(buffer, H);
    expect(buffer.length).toBe(2);
    expect(buffer[0]?.t).toBe(0);
  });

  it('head just past the window edge is NOT treated as a gap', () => {
    // A head 1.5 windows old is past the edge but under the 2× threshold —
    // normal steady-state retention applies.
    const buffer: RateSample[] = [
      sample(0, 0),
      sample(RATE_WINDOW_MS * 1.2, 10),
      sample(RATE_WINDOW_MS * 1.5, 13),
    ];
    pruneRateBuffer(buffer, RATE_WINDOW_MS * 1.5);
    expect(buffer.length).toBe(3);
    expect(buffer[0]?.t).toBe(0);
  });
});
