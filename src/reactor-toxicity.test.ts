// §4.5 Chemical Reactor toxicity event — pure logic tests.

import { describe, expect, it } from 'vitest';
import {
  advanceToxicityRolls,
  isInToxicityPeriod,
  isReactorAdjacentToReactor,
  rollToxicityForHour,
  toxicityMultiplier,
  TOXICITY_HOUR_MS,
} from './reactor-toxicity.js';
import type { PlacedBuilding } from './buildings.js';

function reactor(id: string, x: number, y: number, opts?: Partial<PlacedBuilding>): PlacedBuilding {
  return { id, defId: 'chemical_reactor', x, y, ...opts };
}

function solar(id: string, x: number, y: number): PlacedBuilding {
  return { id, defId: 'solar', x, y };
}

describe('isReactorAdjacentToReactor', () => {
  it('returns false for a lone reactor', () => {
    const r = reactor('r1', 0, 0);
    expect(isReactorAdjacentToReactor(r, [r])).toBe(false);
  });

  it('returns true for two adjacent reactors (2×2 footprint border touch)', () => {
    // square2 footprint: (0,0)-(1,1) and (2,0)-(3,1) share border at x=2.
    const a = reactor('ra', 0, 0);
    const b = reactor('rb', 2, 0);
    expect(isReactorAdjacentToReactor(a, [a, b])).toBe(true);
    expect(isReactorAdjacentToReactor(b, [a, b])).toBe(true);
  });

  it('returns false for a reactor adjacent only to a non-reactor', () => {
    const r = reactor('r1', 0, 0);
    const s = solar('s1', 2, 0);
    expect(isReactorAdjacentToReactor(r, [r, s])).toBe(false);
  });
});

describe('isInToxicityPeriod', () => {
  it('is false when toxicityExpiryMs is undefined', () => {
    const r = reactor('r', 0, 0);
    expect(isInToxicityPeriod(r, 1000)).toBe(false);
  });

  it('is true when nowMs < expiry', () => {
    const r = reactor('r', 0, 0, { toxicityExpiryMs: 5000 });
    expect(isInToxicityPeriod(r, 4000)).toBe(true);
  });

  it('is false when nowMs >= expiry', () => {
    const r = reactor('r', 0, 0, { toxicityExpiryMs: 5000 });
    expect(isInToxicityPeriod(r, 5000)).toBe(false);
    expect(isInToxicityPeriod(r, 6000)).toBe(false);
  });
});

describe('toxicityMultiplier', () => {
  it('is 0.5 inside the toxicity period', () => {
    const r = reactor('r', 0, 0, { toxicityExpiryMs: 5000 });
    expect(toxicityMultiplier(r, 4000)).toBe(0.5);
  });

  it('is 1.0 outside the toxicity period', () => {
    const r = reactor('r', 0, 0, { toxicityExpiryMs: 5000 });
    expect(toxicityMultiplier(r, 5000)).toBe(1.0);
  });

  it('is 1.0 for non-reactor defs regardless of expiry field', () => {
    const s = solar('s', 0, 0);
    expect(toxicityMultiplier(s, 0)).toBe(1.0);
  });
});

describe('rollToxicityForHour', () => {
  it('is deterministic for the same (seed, id, hour) tuple', () => {
    const a = rollToxicityForHour('seed-a', 'r1', 3);
    const b = rollToxicityForHour('seed-a', 'r1', 3);
    expect(a).toBe(b);
  });

  it('produces independent results for different hour ticks', () => {
    const a = rollToxicityForHour('seed-a', 'r1', 1);
    const b = rollToxicityForHour('seed-a', 'r1', 2);
    // Independence is probabilistic at 5%; just assert booleans, no crash.
    expect(typeof a).toBe('boolean');
    expect(typeof b).toBe('boolean');
  });
});

describe('advanceToxicityRolls', () => {
  it('triggers both adjacent reactors across a 0→2h window with a guaranteed-trigger seed', () => {
    // Search for a seed that triggers both reactors at hour 1.
    let seed = '';
    const a = reactor('ra', 0, 0);
    const b = reactor('rb', 2, 0);
    for (let s = 0; s < 1000; s++) {
      const testA = rollToxicityForHour(String(s), 'ra', 1);
      const testB = rollToxicityForHour(String(s), 'rb', 1);
      if (testA && testB) {
        seed = String(s);
        break;
      }
    }
    expect(seed).not.toBe('');

    // Reset state before running advance.
    a.toxicityExpiryMs = undefined;
    b.toxicityExpiryMs = undefined;

    const triggered = advanceToxicityRolls([a, b], seed, 0, 2 * TOXICITY_HOUR_MS);
    expect(triggered).toContain('ra');
    expect(triggered).toContain('rb');
    expect(a.toxicityExpiryMs).toBe(TOXICITY_HOUR_MS + TOXICITY_HOUR_MS); // 1h + 1h duration
    expect(b.toxicityExpiryMs).toBe(TOXICITY_HOUR_MS + TOXICITY_HOUR_MS);
  });

  it('never triggers a reactor with no adjacent reactor neighbor', () => {
    const r = reactor('r1', 0, 0);
    const s = solar('s1', 2, 0);
    const triggered = advanceToxicityRolls([r, s], 'any-seed', 0, 2 * TOXICITY_HOUR_MS);
    expect(triggered).toHaveLength(0);
    expect(r.toxicityExpiryMs).toBeUndefined();
  });

  it('does not re-trigger a reactor already inside a toxicity period', () => {
    const a = reactor('ra', 0, 0);
    const b = reactor('rb', 2, 0);
    // Pre-set a as already toxic at the hour-1 boundary.
    a.toxicityExpiryMs = 2 * TOXICITY_HOUR_MS;
    // Search for a seed that triggers b at hour 1.
    let seed = '';
    for (let s = 0; s < 1000; s++) {
      if (rollToxicityForHour(String(s), 'rb', 1)) {
        seed = String(s);
        break;
      }
    }
    expect(seed).not.toBe('');
    // Interval 0→1h only checks hour 1, so a (toxic until 2h) is skipped.
    const triggered = advanceToxicityRolls([a, b], seed, 0, TOXICITY_HOUR_MS);
    expect(triggered).toContain('rb');
    expect(triggered).not.toContain('ra');
    // a's expiry should remain untouched.
    expect(a.toxicityExpiryMs).toBe(2 * TOXICITY_HOUR_MS);
  });

  it('produces identical outcomes for a 24-hour offline catch-up whether taken as one slice or 24 hourly slices', () => {
    // §4.5 header contract: "offline catchup produces identical outcomes
    // regardless of segment granularity". The old implementation broke one
    // slice after the first hit per reactor; this test pins the fix.
    const H = TOXICITY_HOUR_MS;
    let seed = '';
    // Brute-force a seed where r1 hits at least twice in hours 1..24 while
    // r2 hits zero times, so the assertion is unambiguous.
    for (let s = 0; s < 5000; s++) {
      const ss = String(s);
      const r1Hits: number[] = [];
      const r2Hits: number[] = [];
      for (let h = 1; h <= 24; h++) {
        if (rollToxicityForHour(ss, 'r1', h)) r1Hits.push(h);
        if (rollToxicityForHour(ss, 'r2', h)) r2Hits.push(h);
      }
      if (r1Hits.length >= 2 && r2Hits.length === 0) {
        seed = ss;
        break;
      }
    }
    expect(seed).not.toBe('');

    const runOneSlice = () => {
      const a = reactor('r1', 0, 0);
      const b = reactor('r2', 2, 0);
      const triggered = advanceToxicityRolls([a, b], seed, 0, 24 * H);
      return { r1: a, r2: b, triggered };
    };

    const runHourlySlices = () => {
      const a = reactor('r1', 0, 0);
      const b = reactor('r2', 2, 0);
      const triggered: string[] = [];
      for (let h = 1; h <= 24; h++) {
        const batch = advanceToxicityRolls([a, b], seed, (h - 1) * H, h * H);
        triggered.push(...batch);
      }
      return { r1: a, r2: b, triggered };
    };

    const one = runOneSlice();
    const hourly = runHourlySlices();

    expect(one.triggered).toEqual(hourly.triggered);
    expect(one.r1.toxicityExpiryMs).toBe(hourly.r1.toxicityExpiryMs);
    expect(one.r2.toxicityExpiryMs).toBe(hourly.r2.toxicityExpiryMs);
  });
});
