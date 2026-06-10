// Pure-logic tests for procedural world generation per SPEC §2.1 + §2.3.

import { describe, expect, it } from 'vitest';

import { BIOME_DEFS } from './biomes.js';
import { generateWorld, overlapsAny } from './world-gen.js';
import { DEMO_ISLANDS_TEST_FIXTURE, makeInitialWorld, type Biome } from './world.js';

const ALL_BIOMES: ReadonlyArray<Biome> = [
  'plains',
  'forest',
  'coast',
  'volcanic',
  'desert',
  'arctic',
];

const BASE_OPTS = {
  seed: 'test-seed',
  halfExtentCells: 6,
  cellSizeTiles: 16,
  density: 0.3,
};

describe('generateWorld', () => {
  it('is deterministic given the same seed', () => {
    const a = generateWorld(BASE_OPTS);
    const b = generateWorld(BASE_OPTS);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      const sa = a[i]!;
      const sb = b[i]!;
      expect(sa.id).toBe(sb.id);
      expect(sa.biome).toBe(sb.biome);
      expect(sa.cx).toBe(sb.cx);
      expect(sa.cy).toBe(sb.cy);
      expect(sa.majorRadius).toBe(sb.majorRadius);
      expect(sa.minorRadius).toBe(sb.minorRadius);
      expect(sa.modifiers).toEqual(sb.modifiers);
    }
  });

  it('different seeds produce different worlds', () => {
    const a = generateWorld({ ...BASE_OPTS, seed: 'seed-A' });
    const b = generateWorld({ ...BASE_OPTS, seed: 'seed-B' });
    // Length alone could match by coincidence; centre coords almost
    // certainly won't all match across two seeds.
    let differs = false;
    const minLen = Math.min(a.length, b.length);
    for (let i = 0; i < minLen; i++) {
      if (a[i]!.cx !== b[i]!.cx || a[i]!.cy !== b[i]!.cy || a[i]!.biome !== b[i]!.biome) {
        differs = true;
        break;
      }
    }
    expect(differs || a.length !== b.length).toBe(true);
  });

  it('skips the home cell (0, 0)', () => {
    // Use density=1 to force a placement attempt in every cell. None
    // should sit at the home cell's centre (which would be tile (8, 8)
    // for cellSize=16 — but more importantly, no generated island should
    // have id `gen-0-0`).
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    for (const s of generated) {
      expect(s.id).not.toBe('gen-0-0');
    }
  });

  it('generated islands have biome ∈ BIOME_DEFS keys', () => {
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    for (const s of generated) {
      expect(ALL_BIOMES).toContain(s.biome);
      expect(BIOME_DEFS[s.biome]).toBeDefined();
    }
  });

  it("generated islands' radii match their biome's BIOME_DEFS defaults", () => {
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    for (const s of generated) {
      const def = BIOME_DEFS[s.biome];
      expect(s.majorRadius).toBe(def.initialMajorRadius);
      expect(s.minorRadius).toBe(def.initialMinorRadius);
    }
  });

  it('generated islands start undiscovered, unpopulated, and empty', () => {
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    expect(generated.length).toBeGreaterThan(0);
    for (const s of generated) {
      expect(s.populated).toBe(false);
      expect(s.discovered).toBe(false);
      expect(s.buildings).toEqual([]);
    }
  });

  it('§3.4 Coast islands carry a seeded rotation; other biomes stay at 0', () => {
    // Coast rotation must be a multiple of 22.5° in [0, 360). Other biomes
    // (Plains/Forest/Volcanic/Desert/Arctic) must report rotation 0 (or
    // undefined, which collapses to 0 via `?? 0` at consumer sites).
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    expect(generated.length).toBeGreaterThan(0);
    for (const s of generated) {
      const rot = s.rotation ?? 0;
      if (s.biome === 'coast') {
        // 22.5° = 360 / 16; rotation * 16 / 360 should be an integer in [0, 16).
        const steps = (rot * 16) / 360;
        expect(steps).toBeCloseTo(Math.round(steps), 9);
        expect(Math.round(steps)).toBeGreaterThanOrEqual(0);
        expect(Math.round(steps)).toBeLessThan(16);
      } else {
        expect(rot).toBe(0);
      }
    }
  });

  it('§3.4 Coast rotation is deterministic — same seed yields same rotation per island', () => {
    const a = generateWorld(BASE_OPTS);
    const b = generateWorld(BASE_OPTS);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      const sa = a[i]!;
      const sb = b[i]!;
      expect(sa.id).toBe(sb.id);
      expect(sa.biome).toBe(sb.biome);
      expect(sa.rotation ?? 0).toBe(sb.rotation ?? 0);
    }
  });

  it('§3.4 Coast rotation distribution is not stuck on a single value across seeds', () => {
    // Sanity check: across many generated worlds, Coast rotation should
    // explore more than one of the 16 possible orientations.
    const seen = new Set<number>();
    for (let s = 0; s < 50; s++) {
      const generated = generateWorld({
        ...BASE_OPTS,
        seed: `rotation-${s}`,
        density: 1.0,
      });
      for (const isl of generated) {
        if (isl.biome === 'coast') seen.add(isl.rotation ?? 0);
      }
    }
    // At least 4 distinct rotations across 50 dense seeds — a uniform
    // 16-way roll would put the expected count well above 15 here.
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('frozen_core modifier only appears on arctic islands', () => {
    // Run many seeds; gather every generated island carrying frozen_core
    // and assert the biome is arctic.
    let saw = 0;
    for (let s = 0; s < 20; s++) {
      const generated = generateWorld({
        ...BASE_OPTS,
        seed: `frozen-${s}`,
        density: 1.0,
      });
      for (const isl of generated) {
        if (isl.modifiers.includes('frozen_core')) {
          expect(isl.biome).toBe('arctic');
          saw++;
        }
      }
    }
    // Confidence guard: at least one frozen_core arctic should have rolled
    // somewhere across 20 dense seeds. If not, the modifier might not be
    // wired into the generator at all.
    expect(saw).toBeGreaterThan(0);
  });

  it('no two generated islands overlap (centre-distance ellipse approximation)', () => {
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    for (let i = 0; i < generated.length; i++) {
      for (let j = i + 1; j < generated.length; j++) {
        const a = generated[i]!;
        const b = generated[j]!;
        const dx = a.cx - b.cx;
        const dy = a.cy - b.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minGap =
          Math.max(a.majorRadius, a.minorRadius) +
          Math.max(b.majorRadius, b.minorRadius);
        expect(dist).toBeGreaterThanOrEqual(minGap);
      }
    }
  });

  it("generated islands' terrainAt closure routes through terrainAtForBiome", () => {
    // Calling terrainAt should not throw and should return a valid TerrainKind.
    // (The exact tile a generator picks isn't load-bearing here; we just
    // verify the closure exists and produces a string.)
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0 });
    const s = generated[0]!;
    expect(typeof s.terrainAt).toBe('function');
    const kind = s.terrainAt!(0, 0);
    expect(typeof kind).toBe('string');
  });

  it('respects existingIslands — no generated island overlaps any of them', () => {
    // Make a fake existing island in the middle of the grid and check that
    // no generated island lands on top of it.
    const existing = [
      {
        id: 'mock',
        name: 'mock',
        biome: 'plains' as const,
        cx: 0,
        cy: 0,
        majorRadius: 14,
        minorRadius: 14,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
      },
      {
        id: 'mock2',
        name: 'mock2',
        biome: 'forest' as const,
        cx: 40,
        cy: -10,
        majorRadius: 10,
        minorRadius: 10,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
      },
    ];
    const generated = generateWorld({ ...BASE_OPTS, density: 1.0, existingIslands: existing });
    for (const g of generated) {
      for (const e of existing) {
        const dx = g.cx - e.cx;
        const dy = g.cy - e.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minGap =
          Math.max(g.majorRadius, g.minorRadius) +
          Math.max(e.majorRadius, e.minorRadius);
        expect(dist).toBeGreaterThanOrEqual(minGap);
      }
    }
  });
});

describe('overlapsAny — constituent-aware spacing', () => {
  it('rejects candidate overlapping ONLY an extraEllipse', () => {
    const existing = {
      id: 'merged',
      name: 'merged',
      biome: 'plains' as const,
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
      extraEllipses: [{ major: 5, minor: 5, rotation: 0, offsetX: 30, offsetY: 0 }],
    };
    // Candidate at (40, 0) r=5 overlaps the extra at (30,0) r=5 (distance 10 = 5+5).
    expect(overlapsAny(40, 0, 5, 5, [existing])).toBe(true);
  });

  it('accepts same candidate when the island has no extraEllipses', () => {
    const existing = {
      id: 'merged',
      name: 'merged',
      biome: 'plains' as const,
      cx: 0,
      cy: 0,
      majorRadius: 5,
      minorRadius: 5,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    };
    // Candidate at (40, 0) r=5 is far from the primary (distance 40 >> 5+5).
    expect(overlapsAny(40, 0, 5, 5, [existing])).toBe(false);
  });
});

describe('makeInitialWorld + procedural integration', () => {
  it('keeps the home island present and at world origin', () => {
    // §3.7: the new-game world seeds only home — demo neighbours are
    // retained as DEMO_ISLANDS_TEST_FIXTURE but NOT auto-seeded into
    // makeInitialWorld, so we assert only on home here.
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home');
    expect(home, 'home island missing from initial world').toBeDefined();
    expect(home!.cx).toBe(0);
    expect(home!.cy).toBe(0);
  });

  it('appends procedural islands beyond the single home seed', () => {
    const w = makeInitialWorld(0);
    expect(w.islands.length).toBeGreaterThan(1);
  });

  it('no procedural island overlaps the home island', () => {
    const w = makeInitialWorld(0);
    const home = w.islands.find((s) => s.id === 'home')!;
    const generated = w.islands.filter((s) => s.id !== 'home');
    for (const g of generated) {
      const dx = g.cx - home.cx;
      const dy = g.cy - home.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minGap =
        Math.max(g.majorRadius, g.minorRadius) +
        Math.max(home.majorRadius, home.minorRadius);
      expect(
        dist,
        `procedural ${g.id} overlaps home (dist ${dist.toFixed(1)} vs min ${minGap})`,
      ).toBeGreaterThanOrEqual(minGap);
    }
  });

  it('procedural islands all start unpopulated and undiscovered', () => {
    const w = makeInitialWorld(0);
    const generated = w.islands.filter((s) => s.id !== 'home');
    expect(generated.length).toBeGreaterThan(0);
    for (const g of generated) {
      expect(g.populated).toBe(false);
      expect(g.discovered).toBe(false);
    }
  });

  it('exposes the DEMO_ISLANDS_TEST_FIXTURE for tests that need a known multi-island layout', () => {
    // Smoke test — the fixture must still carry the six canonical demos
    // (home, forest-ne, desert-far, coast-unknown, hidden-w, hidden-s)
    // so the world.test.ts "matches the demo layout" case and any other
    // fixture consumer keeps working. NOT used by makeInitialWorld.
    const ids = DEMO_ISLANDS_TEST_FIXTURE.map((s) => s.id);
    expect(ids).toEqual([
      'home',
      'forest-ne',
      'desert-far',
      'coast-unknown',
      'hidden-w',
      'hidden-s',
    ]);
  });
});
