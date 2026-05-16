// Pure-helper tests for the visual-polish color and jitter functions in
// `island.ts`. Rendering itself isn't tested (it produces PixiJS Graphics
// objects; visual delta is verified by browsing) — these tests cover the
// pure math used by the renderer so a regression in determinism or
// boundary behaviour fails fast.

import { describe, expect, it } from 'vitest';

import {
  defaultTerrainAt,
  desaturate,
  lighten,
  tileBrightnessJitter,
  tileHash01,
} from './island.js';

describe('tileHash01', () => {
  it('is deterministic — same (x, y) returns same value across calls', () => {
    const a = tileHash01(3, 5);
    const b = tileHash01(3, 5);
    expect(a).toBe(b);
  });

  it('produces different values for different (x, y) pairs', () => {
    const a = tileHash01(0, 0);
    const b = tileHash01(1, 0);
    const c = tileHash01(0, 1);
    // We don't require strict uniqueness across the whole grid, but
    // these three points should not collide — a collision here would
    // mean the mix is dropping the x or y contribution.
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it('outputs are in [0, 1)', () => {
    for (let x = -20; x <= 20; x++) {
      for (let y = -20; y <= 20; y++) {
        const h = tileHash01(x, y);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
    }
  });

  it('handles negative coordinates without collapsing to a single value', () => {
    const vals = new Set<number>();
    for (let x = -10; x <= -1; x++) {
      for (let y = -10; y <= -1; y++) {
        vals.add(tileHash01(x, y));
      }
    }
    // 100 input pairs should yield many distinct outputs (modulo
    // floating-point collisions, which would be a sign the hash is
    // broken). We don't require all 100 unique, but a reasonable spread.
    expect(vals.size).toBeGreaterThan(80);
  });
});

describe('tileBrightnessJitter', () => {
  it('is deterministic given (x, y, baseColor)', () => {
    const a = tileBrightnessJitter(7, -3, 0x4a7c44);
    const b = tileBrightnessJitter(7, -3, 0x4a7c44);
    expect(a).toBe(b);
  });

  it('stays close to the base colour — jitter ±5% lightness', () => {
    // Pick a mid-grey so we can bound the per-channel delta. 5% of 255
    // is ~12.75 — every channel must stay within that envelope.
    const base = 0x808080;
    const baseR = 0x80;
    for (let x = -10; x <= 10; x++) {
      for (let y = -10; y <= 10; y++) {
        const out = tileBrightnessJitter(x, y, base);
        const r = (out >>> 16) & 0xff;
        const g = (out >>> 8) & 0xff;
        const b = out & 0xff;
        // ±13 covers the rounded ±5% envelope plus floating-point slack.
        expect(Math.abs(r - baseR)).toBeLessThanOrEqual(13);
        expect(Math.abs(g - baseR)).toBeLessThanOrEqual(13);
        expect(Math.abs(b - baseR)).toBeLessThanOrEqual(13);
      }
    }
  });

  it('produces in-range channel values (0..255) for boundary colours', () => {
    // Pure black should never underflow; pure white should never overflow.
    for (let x = -5; x <= 5; x++) {
      for (let y = -5; y <= 5; y++) {
        const outBlack = tileBrightnessJitter(x, y, 0x000000);
        const outWhite = tileBrightnessJitter(x, y, 0xffffff);
        for (const out of [outBlack, outWhite]) {
          const r = (out >>> 16) & 0xff;
          const g = (out >>> 8) & 0xff;
          const b = out & 0xff;
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(255);
          expect(g).toBeGreaterThanOrEqual(0);
          expect(g).toBeLessThanOrEqual(255);
          expect(b).toBeGreaterThanOrEqual(0);
          expect(b).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('jitter varies across nearby tiles (texture, not flat)', () => {
    // Sample a 5×5 window and demand at least 10 distinct output colours.
    // If jitter were a no-op the set would have size 1.
    const set = new Set<number>();
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        set.add(tileBrightnessJitter(x, y, 0x4a7c44));
      }
    }
    expect(set.size).toBeGreaterThan(10);
  });
});

describe('desaturate', () => {
  it('amount=0 is identity', () => {
    expect(desaturate(0xff8c2a, 0)).toBe(0xff8c2a);
    expect(desaturate(0x4a7c44, 0)).toBe(0x4a7c44);
  });

  it('amount=1 collapses to grayscale (R=G=B)', () => {
    for (const hex of [0xff0000, 0x00ff00, 0x0000ff, 0xff8c2a, 0x3a7bd5]) {
      const out = desaturate(hex, 1);
      const r = (out >>> 16) & 0xff;
      const g = (out >>> 8) & 0xff;
      const b = out & 0xff;
      // Allow ±1 for rounding.
      expect(Math.abs(r - g)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - b)).toBeLessThanOrEqual(1);
    }
  });

  it('partial desaturation reduces chroma (channel spread shrinks)', () => {
    const hex = 0xff0000; // pure red, max chroma
    const partial = desaturate(hex, 0.5);
    const r = (partial >>> 16) & 0xff;
    const g = (partial >>> 8) & 0xff;
    const b = partial & 0xff;
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    expect(spread).toBeLessThan(255);  // less than the full-chroma spread
    expect(spread).toBeGreaterThan(0); // not collapsed (amount<1)
  });

  it('clamps the amount parameter to [0, 1]', () => {
    // amount=-1 should behave as 0; amount=2 should behave as 1.
    expect(desaturate(0xff8c2a, -1)).toBe(desaturate(0xff8c2a, 0));
    expect(desaturate(0xff8c2a, 2)).toBe(desaturate(0xff8c2a, 1));
  });
});

describe('lighten', () => {
  it('amount=0 is identity', () => {
    expect(lighten(0x4a7c44, 0)).toBe(0x4a7c44);
  });

  it('amount=1 collapses to white', () => {
    expect(lighten(0x000000, 1)).toBe(0xffffff);
    expect(lighten(0x4a7c44, 1)).toBe(0xffffff);
  });

  it('partial lightening monotonically increases each channel toward 255', () => {
    const hex = 0x40608a;
    const r0 = (hex >>> 16) & 0xff;
    const g0 = (hex >>> 8) & 0xff;
    const b0 = hex & 0xff;
    const out = lighten(hex, 0.5);
    const r = (out >>> 16) & 0xff;
    const g = (out >>> 8) & 0xff;
    const b = out & 0xff;
    expect(r).toBeGreaterThan(r0);
    expect(g).toBeGreaterThan(g0);
    expect(b).toBeGreaterThan(b0);
    expect(r).toBeLessThan(255);
    expect(g).toBeLessThan(255);
    expect(b).toBeLessThan(255);
  });
});

describe('defaultTerrainAt — bootstrap seeds', () => {
  it('home has at least 2 tree tiles (Logger requirement, §8.1)', () => {
    const tiles: Array<[number, number]> = [];
    for (let x = -14; x <= 14; x++) {
      for (let y = -14; y <= 14; y++) {
        if (defaultTerrainAt(x, y) === 'tree') tiles.push([x, y]);
      }
    }
    expect(tiles.length).toBeGreaterThanOrEqual(2);
  });

  it('home has a 2x2 stone cluster (Quarry footprint, §8.1)', () => {
    let found = false;
    for (let x = -14; x <= 13 && !found; x++) {
      for (let y = -14; y <= 13 && !found; y++) {
        if (
          defaultTerrainAt(x, y) === 'stone' &&
          defaultTerrainAt(x + 1, y) === 'stone' &&
          defaultTerrainAt(x, y + 1) === 'stone' &&
          defaultTerrainAt(x + 1, y + 1) === 'stone'
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('home has a 2x2 oil_well cluster (Pump Jack 2x2 footprint, §4.3 every-tile rule)', () => {
    // §4.3: requiredTile demands EVERY footprint tile match. Pump Jack is
    // 2x2 + requiredTile: ['oil_well'], so a single seeded tile fails the
    // gate with three grass corners. Verify a placeable 2x2 cluster exists.
    let found = false;
    for (let x = -14; x <= 13 && !found; x++) {
      for (let y = -14; y <= 13 && !found; y++) {
        if (
          defaultTerrainAt(x, y) === 'oil_well' &&
          defaultTerrainAt(x + 1, y) === 'oil_well' &&
          defaultTerrainAt(x, y + 1) === 'oil_well' &&
          defaultTerrainAt(x + 1, y + 1) === 'oil_well'
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('home has a 2x2 limestone cluster (Limestone Quarry 2x2 footprint, §4.3)', () => {
    let found = false;
    for (let x = -14; x <= 13 && !found; x++) {
      for (let y = -14; y <= 13 && !found; y++) {
        if (
          defaultTerrainAt(x, y) === 'limestone' &&
          defaultTerrainAt(x + 1, y) === 'limestone' &&
          defaultTerrainAt(x, y + 1) === 'limestone' &&
          defaultTerrainAt(x + 1, y + 1) === 'limestone'
        ) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });
});
