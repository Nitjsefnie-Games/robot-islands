import { describe, expect, it } from 'vitest';
import {
  ACTIVE_BONUS_PER_MIN,
  ACTIVE_DECAY_RATIO,
  activeBonusMul,
  applyActiveBonusDelta,
  tickActiveBonus,
} from './active-bonus.js';
import { ONLINE_DT_CAP_MS } from './trade.js';
import { makeInitialWorld } from './world.js';

describe('tickActiveBonus (§9.9 accrual law)', () => {
  it('accrues focused frame dt 1:1', () => {
    const w = { activeBonusMs: 0 };
    tickActiveBonus(w, true, 1000);
    expect(w.activeBonusMs).toBe(1000);
  });

  it('clamps single-frame accrual at ONLINE_DT_CAP_MS and decays the excess (refocus after hidden gap)', () => {
    // While hidden, rAF stops; the whole gap arrives as one frameDt on the
    // refocus frame. Accrue at most the 3 s cap; the remainder decays at 3×.
    const w = { activeBonusMs: 600_000 };
    const gap = 60_000;
    tickActiveBonus(w, true, gap);
    expect(w.activeBonusMs).toBe(
      600_000 + ONLINE_DT_CAP_MS - ACTIVE_DECAY_RATIO * (gap - ONLINE_DT_CAP_MS),
    );
    expect(w.activeBonusMs).toBe(432_000); // 600_000 + 3_000 − 3 × 57_000, pinned literal
  });

  it('decays blurred-but-visible frames at 3×', () => {
    const w = { activeBonusMs: 10_000 };
    tickActiveBonus(w, false, 1000);
    expect(w.activeBonusMs).toBe(7000);
  });

  it('floors at 0', () => {
    const w = { activeBonusMs: 500 };
    tickActiveBonus(w, false, 60_000);
    expect(w.activeBonusMs).toBe(0);
  });

  it('treats a missing field as 0 (fixture back-compat)', () => {
    const w: { activeBonusMs?: number } = {};
    tickActiveBonus(w, true, 2000);
    expect(w.activeBonusMs).toBe(2000);
  });

  it('ignores zero and negative dt', () => {
    const w = { activeBonusMs: 123 };
    tickActiveBonus(w, true, 0);
    tickActiveBonus(w, false, -5);
    expect(w.activeBonusMs).toBe(123);
  });
});

describe('applyActiveBonusDelta (§9.9 server heartbeat)', () => {
  it('accrues focused ms', () => {
    const w = { activeBonusMs: 1000 };
    applyActiveBonusDelta(w, 5000, 0);
    expect(w.activeBonusMs).toBe(6000);
  });

  it('decays at 3× unfocused ms', () => {
    const w = { activeBonusMs: 10_000 };
    applyActiveBonusDelta(w, 0, 3000);
    expect(w.activeBonusMs).toBe(1000);
  });

  it('floors at 0', () => {
    const w = { activeBonusMs: 500 };
    applyActiveBonusDelta(w, 0, 10_000);
    expect(w.activeBonusMs).toBe(0);
  });

  it('ignores negative inputs', () => {
    const w = { activeBonusMs: 1000 };
    applyActiveBonusDelta(w, -1000, -2000);
    expect(w.activeBonusMs).toBe(1000);
  });
});

describe('makeInitialWorld §9.9 seed', () => {
  it('seeds activeBonusMs at 0', () => {
    expect(makeInitialWorld(0).activeBonusMs).toBe(0);
  });
});

describe('activeBonusMul', () => {
  it('is 1 at zero balance (and for a missing field)', () => {
    expect(activeBonusMul({ activeBonusMs: 0 })).toBe(1);
    expect(activeBonusMul({})).toBe(1);
  });

  it('is +0.1% per focused minute, uncapped', () => {
    expect(activeBonusMul({ activeBonusMs: 60_000 })).toBeCloseTo(1 + ACTIVE_BONUS_PER_MIN, 12);
    // 10 h of focused play → +60%
    expect(activeBonusMul({ activeBonusMs: 10 * 60 * 60_000 })).toBeCloseTo(1.6, 12);
  });
});
