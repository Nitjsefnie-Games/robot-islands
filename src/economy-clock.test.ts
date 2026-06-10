import { describe, expect, it } from 'vitest';
import { ECONOMY_TICK_MS, shouldTick } from './economy-clock.js';

describe('economy-clock', () => {
  it('ECONOMY_TICK_MS is 200 ms (5 Hz)', () => {
    expect(ECONOMY_TICK_MS).toBe(200);
  });

  it('first frame (null lastTick) ticks immediately', () => {
    expect(shouldTick(0, null)).toBe(true);
    expect(shouldTick(123456.7, null)).toBe(true);
  });

  it('does not tick before the cadence elapses', () => {
    expect(shouldTick(1000, 1000)).toBe(false);
    expect(shouldTick(1000 + 16.7, 1000)).toBe(false); // one 60fps frame later
    expect(shouldTick(1000 + ECONOMY_TICK_MS - 0.001, 1000)).toBe(false);
  });

  it('ticks at exactly the cadence boundary', () => {
    expect(shouldTick(1000 + ECONOMY_TICK_MS, 1000)).toBe(true);
  });

  it('ticks past the boundary', () => {
    expect(shouldTick(1000 + ECONOMY_TICK_MS + 50, 1000)).toBe(true);
  });

  it('a long gap yields one advance with the whole gap as dt, not a loop of 200 ms steps', () => {
    // 24 h gap: the gate fires once. The caller stamps lastTick = now and
    // advanceIsland integrates the full interval in one call — so right
    // after stamping, the very next frame must be below the cadence again.
    const dayMs = 24 * 3600 * 1000;
    expect(shouldTick(1000 + dayMs, 1000)).toBe(true);
    const stamped = 1000 + dayMs;
    expect(shouldTick(stamped + 16.7, stamped)).toBe(false);
    expect(shouldTick(stamped + ECONOMY_TICK_MS, stamped)).toBe(true);
  });

  it('a backwards clock (now < lastTick) does not tick', () => {
    expect(shouldTick(900, 1000)).toBe(false);
  });

  it('respects a custom cadence', () => {
    expect(shouldTick(1099, 1000, 100)).toBe(false);
    expect(shouldTick(1100, 1000, 100)).toBe(true);
  });
});
