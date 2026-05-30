// Pure-logic tests for the procedural-world seeded RNG.

import { describe, expect, it } from 'vitest';

import { makeSeededRng, mulberry32, xmur3 } from './rng.js';

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('produces a different sequence for a different seed', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    // A single draw could collide; across 50 draws the streams must diverge.
    let differed = false;
    for (let i = 0; i < 50; i++) {
      if (a() !== b()) {
        differed = true;
        break;
      }
    }
    expect(differed).toBe(true);
  });

  it('output lies in [0, 1)', () => {
    const r = mulberry32(0xdeadbeef);
    for (let i = 0; i < 10000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('xmur3', () => {
  it('produces the same numeric seed for the same input string', () => {
    const a = xmur3('hello world')();
    const b = xmur3('hello world')();
    expect(a).toBe(b);
  });

  it('produces different numeric seeds for different input strings', () => {
    const a = xmur3('foo')();
    const b = xmur3('bar')();
    expect(a).not.toBe(b);
  });

  it('returns 32-bit unsigned integers', () => {
    const mint = xmur3('test');
    for (let i = 0; i < 100; i++) {
      const v = mint();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('makeSeededRng', () => {
  it('is deterministic across separate calls with the same string seed', () => {
    const a = makeSeededRng('rio-2026');
    const b = makeSeededRng('rio-2026');
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('different string seeds yield diverging streams', () => {
    const a = makeSeededRng('seed-1');
    const b = makeSeededRng('seed-2');
    let differed = false;
    for (let i = 0; i < 50; i++) {
      if (a() !== b()) {
        differed = true;
        break;
      }
    }
    expect(differed).toBe(true);
  });

  it('output lies in [0, 1)', () => {
    const r = makeSeededRng('range-check');
    for (let i = 0; i < 5000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
