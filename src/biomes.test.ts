// Pure-logic tests for the biome + modifier system per SPEC §3.2 / §3.5.

import { describe, expect, it } from 'vitest';

import {
  ALL_MODIFIERS,
  BIOME_DEFS,
  effectiveModifierMultipliers,
  IDENTITY_MODIFIER_MULTIPLIERS,
  MODIFIER_DEFS,
  rerollModifiers,
  rollModifiers,
  terrainAtForBiome,
} from './biomes.js';
import { computeIslandTiles, defaultTerrainAt, tileInscribedInEllipse, type TerrainKind } from './island.js';
import { attachTerrainAt } from './world.js';
import type { Biome } from './world.js';

/** Most tests in this file don't care about the inscription predicate — they
 *  just verify determinism, biome distinctness, etc. — so they pass this
 *  permissive predicate that says every tile is inscribed (no cluster-cell
 *  demotion). The dedicated boundary-fragment test below builds a REAL
 *  inscription predicate from `tileInscribedInEllipse` and asserts the
 *  cluster-cell invariant. */
const TRUE_PRED = (): boolean => true;

const ALL_BIOMES: ReadonlyArray<Biome> = [
  'plains',
  'forest',
  'coast',
  'volcanic',
  'desert',
  'arctic',
];

/** Tiny seeded LCG so the tests are deterministic without depending on
 *  Math.random or a heavy RNG library. Numerical Recipes constants. The
 *  seed is mixed via an xmur3-style avalanche before initialising the
 *  state so consecutive small integer seeds don't produce strongly
 *  correlated first-call output (a well-known LCG defect). */
function lcg(seed: number): () => number {
  let s = seed | 0;
  // xmur3-style seed mixer.
  s = Math.imul(s ^ (s >>> 16), 2246822507);
  s = Math.imul(s ^ (s >>> 13), 3266489909);
  s = (s ^ (s >>> 16)) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('BIOME_DEFS catalog', () => {
  it('has an entry for every Biome literal', () => {
    for (const b of ALL_BIOMES) {
      const def = BIOME_DEFS[b];
      expect(def, `missing BIOME_DEFS[${b}]`).toBeDefined();
      expect(def.id).toBe(b);
      expect(def.initialMajorRadius).toBeGreaterThan(0);
      expect(def.initialMinorRadius).toBeGreaterThan(0);
      expect(def.displayName.length).toBeGreaterThan(0);
    }
  });
  it('matches SPEC §3.4 initial radii for each biome', () => {
    expect(BIOME_DEFS.plains.initialMajorRadius).toBe(14);
    expect(BIOME_DEFS.plains.initialMinorRadius).toBe(14);
    expect(BIOME_DEFS.forest.initialMajorRadius).toBe(10);
    expect(BIOME_DEFS.forest.initialMinorRadius).toBe(10);
    expect(BIOME_DEFS.coast.initialMajorRadius).toBe(14);
    expect(BIOME_DEFS.coast.initialMinorRadius).toBe(7);
    expect(BIOME_DEFS.volcanic.initialMajorRadius).toBe(7);
    expect(BIOME_DEFS.volcanic.initialMinorRadius).toBe(7);
    expect(BIOME_DEFS.desert.initialMajorRadius).toBe(12);
    expect(BIOME_DEFS.desert.initialMinorRadius).toBe(12);
    expect(BIOME_DEFS.arctic.initialMajorRadius).toBe(10);
    expect(BIOME_DEFS.arctic.initialMinorRadius).toBe(10);
  });
  it('Plains rareTerrain includes tree (§8.1 bootstrap)', () => {
    expect(BIOME_DEFS.plains.rareTerrain).toContain('tree');
  });
});

describe('MODIFIER_DEFS catalog', () => {
  it('has an entry for every ModifierId', () => {
    for (const id of ALL_MODIFIERS) {
      const def = MODIFIER_DEFS[id];
      expect(def, `missing MODIFIER_DEFS[${id}]`).toBeDefined();
      expect(def.id).toBe(id);
      expect(def.weight).toBeGreaterThan(0);
      expect(def.displayName.length).toBeGreaterThan(0);
    }
  });
  it('marks all modifiers as placeholder=false (no remaining placeholders)', () => {
    for (const id of ALL_MODIFIERS) {
      expect(MODIFIER_DEFS[id].placeholder, `${id} should be wired`).toBe(false);
    }
  });
  it('frozen_core is biome-restricted to arctic', () => {
    expect(MODIFIER_DEFS.frozen_core.biomeRestriction).toEqual(['arctic']);
  });
  it('geothermal_active has biomeWeightMul scaling Volcanic up and others down', () => {
    const m = MODIFIER_DEFS.geothermal_active.biomeWeightMul!;
    expect(m.volcanic).toBeGreaterThan(1);
    expect(m.plains ?? 1).toBeLessThan(1);
  });
});

describe('rollModifiers (§3.5)', () => {
  it('is deterministic given the same seeded RNG', () => {
    const r1 = rollModifiers('s', 'plains', lcg(42));
    const r2 = rollModifiers('s', 'plains', lcg(42));
    expect(r1).toEqual(r2);
  });

  it('returns [] when count rolls 0 (rng < 0.5 on first call)', () => {
    // First rng() drives the count roll; thresholds {0:0.50, 1:0.80, 2:0.95, 3:1.00}.
    // A constant rng returning 0.4 means count=0. Returns immediately.
    const rng = (): number => 0.4;
    expect(rollModifiers('seed', 'plains', rng)).toEqual([]);
  });

  it('returns ["stable"] when first draw lands on Stable, regardless of count', () => {
    let i = 0;
    const seq = [0.96 /* count=3 */, /* first draw via cumulative weighted: trick by giving small r */ 0.0001];
    const rng = (): number => {
      const v = seq[i] ?? 0;
      i += 1;
      return v;
    };
    // Seed-search for a known-Stable first draw, then assert collapse to
    // ['stable'] (Stable-mutual-exclusivity).
    void rng;
    let found = false;
    for (let seed = 1; seed < 200; seed++) {
      const r = rollModifiers('s', 'plains', lcg(seed));
      if (r.length === 1 && r[0] === 'stable') {
        found = true;
        break;
      }
    }
    expect(found, 'expected at least one seed in [1,200) to roll Stable on Plains').toBe(true);
    // The collapse property is stronger than "['stable'] sometimes appears";
    // we assert that whenever 'stable' is in the result, it is the ONLY entry.
    // (This holds whether it was rolled first or not — Stable can never co-appear.)
    for (let seed = 0; seed < 1000; seed++) {
      const r = rollModifiers('s', 'plains', lcg(seed));
      if (r.includes('stable')) {
        expect(r, `seed ${seed} produced a multi-modifier set including stable`).toEqual(['stable']);
      }
    }
  });

  it('removes Stable from subsequent draws when first draw is non-Stable', () => {
    // Stronger statement of mutual exclusivity: across many seeds, no result
    // of length >= 2 contains 'stable'. Combined with the previous test
    // (every result containing 'stable' has length 1), this fully exercises
    // both branches of §3.5's Stable rule.
    for (let seed = 0; seed < 1000; seed++) {
      const r = rollModifiers('s', 'plains', lcg(seed));
      if (r.length >= 2) {
        expect(r.includes('stable'), `seed ${seed}: stable co-appeared with others`).toBe(false);
      }
    }
  });

  it('biome-restricted modifiers do not roll on excluded biomes', () => {
    // frozen_core is arctic-only. Across many seeds it should never appear
    // on plains/forest/coast/volcanic/desert.
    for (const b of ['plains', 'forest', 'coast', 'volcanic', 'desert'] as Biome[]) {
      for (let seed = 0; seed < 1000; seed++) {
        const r = rollModifiers('s', b, lcg(seed));
        expect(r.includes('frozen_core'), `${b} seed ${seed}: frozen_core leaked`).toBe(false);
      }
    }
  });

  it('frozen_core CAN appear on arctic islands', () => {
    let saw = false;
    for (let seed = 0; seed < 5000; seed++) {
      const r = rollModifiers('s', 'arctic', lcg(seed));
      if (r.includes('frozen_core')) {
        saw = true;
        break;
      }
    }
    expect(saw, 'expected frozen_core to appear at least once on arctic in 5000 seeds').toBe(true);
  });

  it('respects biome weighting — geothermal_active is more frequent on volcanic', () => {
    // §3.5 says weight 12 on Volcanic, 3 elsewhere — i.e. ~4× more frequent.
    // Use 5000 trials per biome; the volcanic count should clearly exceed plains.
    let volc = 0;
    let plains = 0;
    for (let seed = 0; seed < 5000; seed++) {
      const rv = rollModifiers('s', 'volcanic', lcg(seed));
      const rp = rollModifiers('s', 'plains', lcg(seed));
      if (rv.includes('geothermal_active')) volc++;
      if (rp.includes('geothermal_active')) plains++;
    }
    expect(volc).toBeGreaterThan(plains * 2);
  });
});

describe('effectiveModifierMultipliers', () => {
  it('returns identity multipliers for an empty modifier list', () => {
    const m = effectiveModifierMultipliers([]);
    expect(m.globalRecipeRate).toBe(1);
    expect(m.recipeRateByCategory.extraction).toBe(1);
    expect(m.recipeRateByCategory.smelting).toBe(1);
    expect(m.recipeRateByCategory.manufacturing).toBe(1);
    expect(m.recipeRateByCategory.power).toBe(1);
    expect(m.windPowerMul).toBe(1);
  });

  it('mineral_rich applies +25% to extraction only', () => {
    const m = effectiveModifierMultipliers(['mineral_rich']);
    expect(m.recipeRateByCategory.extraction).toBeCloseTo(1.25, 12);
    expect(m.recipeRateByCategory.smelting).toBe(1);
    expect(m.recipeRateByCategory.manufacturing).toBe(1);
    expect(m.globalRecipeRate).toBe(1);
  });

  it('cursed_storms applies -10% globally', () => {
    const m = effectiveModifierMultipliers(['cursed_storms']);
    expect(m.globalRecipeRate).toBeCloseTo(0.9, 12);
    expect(m.recipeRateByCategory.extraction).toBe(1);
  });

  it('fertile applies +50% to extraction', () => {
    const m = effectiveModifierMultipliers(['fertile']);
    expect(m.recipeRateByCategory.extraction).toBeCloseTo(1.5, 12);
  });

  it('stable is a no-op multiplier', () => {
    const m = effectiveModifierMultipliers(['stable']);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
  });

  it('aetheric_anomaly gives 1.5× T5 extraction rate', () => {
    const m = effectiveModifierMultipliers(['aetheric_anomaly']);
    expect(m.t5ExtractionRateMul).toBeCloseTo(1.5, 12);
    expect(m.globalRecipeRate).toBe(1);
  });

  it('frozen_core doubles cryo recipe rate', () => {
    const m = effectiveModifierMultipliers(['frozen_core']);
    expect(m.cryoRecipeRateMul).toBe(2);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
  });

  it('geothermal_active is a structural no-op in multiplier fold', () => {
    const m = effectiveModifierMultipliers(['geothermal_active']);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
    expect(m.outputVariance).toBe(false);
    expect(m.t5ExtractionRateMul).toBe(1);
    expect(m.cryoRecipeRateMul).toBe(1);
    expect(m.windPowerMul).toBe(1);
  });

  it('high_wind sets outputVariance=true, windPowerMul=1.5, and leaves recipe rates unchanged', () => {
    const m = effectiveModifierMultipliers(['high_wind']);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
    expect(m.outputVariance).toBe(true);
    expect(m.windPowerMul).toBeCloseTo(1.5, 12);
  });

  it('high_wind composes with mineral_rich: windPowerMul=1.5, extraction=1.25, variance=true', () => {
    const m = effectiveModifierMultipliers(['high_wind', 'mineral_rich']);
    expect(m.windPowerMul).toBeCloseTo(1.5, 12);
    expect(m.recipeRateByCategory.extraction).toBeCloseTo(1.25, 12);
    expect(m.outputVariance).toBe(true);
    expect(m.globalRecipeRate).toBe(1);
  });

  it('mineral_rich + fertile compose multiplicatively on extraction (1.25 × 1.5)', () => {
    const m = effectiveModifierMultipliers(['mineral_rich', 'fertile']);
    expect(m.recipeRateByCategory.extraction).toBeCloseTo(1.25 * 1.5, 12);
  });

  it('mineral_rich + cursed_storms compose: extraction=1.25, global=0.9', () => {
    const m = effectiveModifierMultipliers(['mineral_rich', 'cursed_storms']);
    expect(m.recipeRateByCategory.extraction).toBeCloseTo(1.25, 12);
    expect(m.globalRecipeRate).toBeCloseTo(0.9, 12);
  });

  it('IDENTITY_MODIFIER_MULTIPLIERS is the all-1 bundle', () => {
    expect(IDENTITY_MODIFIER_MULTIPLIERS.globalRecipeRate).toBe(1);
    for (const c of Object.values(IDENTITY_MODIFIER_MULTIPLIERS.recipeRateByCategory)) {
      expect(c).toBe(1);
    }
    expect(IDENTITY_MODIFIER_MULTIPLIERS.outputVariance).toBe(false);
    expect(IDENTITY_MODIFIER_MULTIPLIERS.windPowerMul).toBe(1);
  });
});

describe('terrainAtForBiome', () => {
  it('is deterministic given the same (islandId, x, y)', () => {
    const a = terrainAtForBiome('forest', 'forest-1', 3, -2, TRUE_PRED);
    const b = terrainAtForBiome('forest', 'forest-1', 3, -2, TRUE_PRED);
    expect(a).toBe(b);
  });

  it('no longer special-cases the home id — it generates procedural plains', () => {
    // §3.7 change: the `islandId === 'home'` short-circuit was removed from
    // terrainAtForBiome. The locked starter layout now lives in attachTerrainAt
    // (see "home base layout" below). Here we pin that terrainAtForBiome treats
    // 'home' like any other seed — i.e. it produces procedural plains, NOT the
    // hand-placed defaultTerrainAt. At least one tile must differ from the hand
    // layout (otherwise the short-circuit is silently back).
    let differs = 0;
    for (let y = -14; y <= 14; y++) {
      for (let x = -14; x <= 14; x++) {
        if (!tileInscribedInEllipse(x, y, 14, 14)) continue;
        if (terrainAtForBiome('plains', 'home', x, y, TRUE_PRED) !== defaultTerrainAt(x, y)) differs++;
      }
    }
    expect(differs, 'terrainAtForBiome must no longer return the home hand-layout').toBeGreaterThan(0);
  });

  it('home base layout is locked within baseLayoutRadius and procedural beyond (§3.7)', () => {
    // A grown home: original footprint r16, expanded to r28 via Land Reclamation.
    const home = attachTerrainAt({
      id: 'home',
      name: 'home',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 28,
      minorRadius: 28,
      baseLayoutRadius: 16,
      populated: true,
      discovered: true,
      buildings: [],
      modifiers: [],
    });
    // Within r16 — the locked hand-placed starter layout, identical to defaultTerrainAt.
    for (let y = -16; y <= 16; y++) {
      for (let x = -16; x <= 16; x++) {
        if (!tileInscribedInEllipse(x, y, 16, 16)) continue;
        expect(home.terrainAt!(x, y), `home base (${x},${y}) drift`).toBe(defaultTerrainAt(x, y));
      }
    }
    // The grown ring (16 < r ≤ 28) must NOT be all grass — growth pulls
    // procedural plains terrain (tree/stone/ore/coal/limestone veins).
    let ringTiles = 0;
    let nonGrass = 0;
    for (let y = -28; y <= 28; y++) {
      for (let x = -28; x <= 28; x++) {
        if (!tileInscribedInEllipse(x, y, 28, 28)) continue;
        if (tileInscribedInEllipse(x, y, 16, 16)) continue; // skip the locked base
        ringTiles++;
        if (home.terrainAt!(x, y) !== 'grass') nonGrass++;
      }
    }
    expect(ringTiles).toBeGreaterThan(0);
    expect(nonGrass, 'grown ring must carry procedural (non-grass) terrain').toBeGreaterThan(0);
  });

  it('produces biome-distinct default terrain on non-home islands', () => {
    // For each biome, assert that the most common tile across a sweep
    // matches that biome's defaultTerrain field. This is the visual-
    // distinctness contract: "Forest is greener, Desert is tan, etc."
    for (const b of ALL_BIOMES) {
      const def = BIOME_DEFS[b];
      const counts = new Map<string, number>();
      for (let y = -8; y <= 8; y++) {
        for (let x = -8; x <= 8; x++) {
          const t = terrainAtForBiome(b, `test-${b}`, x, y, TRUE_PRED);
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      let topKind = '';
      let topCount = -1;
      for (const [k, v] of counts) {
        if (v > topCount) {
          topKind = k;
          topCount = v;
        }
      }
      expect(topKind, `${b} most-common terrain`).toBe(def.defaultTerrain);
    }
  });

  it('different biomes produce different terrain at the same coordinate', () => {
    // Pick a coord outside any home-special list and verify forest≠desert.
    // The hash includes the islandId — even with same (x,y), different
    // biomes' default + rare palette differ.
    const a = terrainAtForBiome('forest', 'a', 0, 0, TRUE_PRED);
    const b = terrainAtForBiome('desert', 'a', 0, 0, TRUE_PRED);
    // We don't require !== (could collide if both pick a shared rare like
    // stone), so the stronger property is "the default-terrain swap shows
    // up across many points."
    void a;
    void b;
    let differences = 0;
    for (let y = -5; y <= 5; y++) {
      for (let x = -5; x <= 5; x++) {
        const fa = terrainAtForBiome('forest', 'X', x, y, TRUE_PRED);
        const da = terrainAtForBiome('desert', 'X', x, y, TRUE_PRED);
        if (fa !== da) differences++;
      }
    }
    expect(differences).toBeGreaterThan(50);
  });

  it('includes new terrain kinds (oil_well, gas_seep, helium_vent) in appropriate biomes', () => {
    // Sample many tiles across multiple island ids to hit rareTerrain
    // entries. We only assert that each new kind shows up SOMEWHERE
    // in its expected biome, not at a specific coordinate.
    const findAny = (biome: Biome, kind: TerrainKind) => {
      // Wider scan than tile-density alone would need — clustering means
      // the effective number of independent rolls is (range/CLUSTER_TILES)²,
      // so low-weight rares (helium_vent is 1/16 of volcanic rares) need a
      // larger window to show up reliably.
      for (let y = -30; y <= 30; y++) {
        for (let x = -30; x <= 30; x++) {
          if (terrainAtForBiome(biome, `scan-${kind}`, x, y, TRUE_PRED) === kind) return true;
        }
      }
      return false;
    };
    expect(findAny('desert', 'oil_well')).toBe(true);
    expect(findAny('coast', 'oil_well')).toBe(true);
    expect(findAny('coast', 'gas_seep')).toBe(true);
    expect(findAny('volcanic', 'gas_seep')).toBe(true);
    expect(findAny('volcanic', 'helium_vent')).toBe(true);
    expect(findAny('arctic', 'helium_vent')).toBe(true);
  });

  it('produces axis-aligned rare clusters that fit 2×2 extractors', () => {
    // Sweep a procedural plains island and assert at least one 2×2 anchor
    // of some rare terrain exists — 2×2 extractor placement must be reachable
    // on procedural islands. Sample a few island ids so a single unlucky
    // seed can't fail the test.
    for (const id of ['plains-A', 'plains-B', 'plains-C']) {
      let found = false;
      for (let y = -14; y < 14 && !found; y++) {
        for (let x = -14; x < 14 && !found; x++) {
          const t = terrainAtForBiome('plains', id, x, y, TRUE_PRED);
          if (t === 'grass') continue;
          if (
            terrainAtForBiome('plains', id, x + 1, y, TRUE_PRED) === t &&
            terrainAtForBiome('plains', id, x, y + 1, TRUE_PRED) === t &&
            terrainAtForBiome('plains', id, x + 1, y + 1, TRUE_PRED) === t
          ) {
            found = true;
          }
        }
      }
      expect(found, `${id} should have at least one 2×2 rare cluster`).toBe(true);
    }
  });

  it('rare clusters never straddle the ellipse boundary (no boundary fragments)', () => {
    // Build a real 14×14 plains island via computeIslandTiles + a terrainAt
    // closure that uses the spec-derived inscription predicate — same path
    // world.ts uses for procedural islands. The invariant: every rare-color
    // tile in the result has all 8 of its 3×3 cluster cell siblings present
    // (and same terrain). A "boundary fragment" — a rare tile in a cluster
    // cell whose other 8 tiles are outside the ellipse — fails this check.
    //
    // Under commit 8fa6bba (the cluster-cell change before this fix), this
    // test fails on plains-B's (-5,-2) cell among others (only 2/9 tiles
    // inscribed → 2-tile ore fragment hugging the silhouette).
    const major = 14;
    const minor = 14;
    const inscribed = (px: number, py: number): boolean =>
      tileInscribedInEllipse(px, py, major, minor);
    for (const id of ['plains-A', 'plains-B', 'plains-C', 'plains-D', 'plains-E']) {
      const tiles = computeIslandTiles(major, minor, (x, y) =>
        terrainAtForBiome('plains', id, x, y, inscribed),
      );
      const tileMap = new Map<string, TerrainKind>();
      for (const t of tiles) tileMap.set(`${t.x},${t.y}`, t.terrain);
      const def = 'grass'; // plains defaultTerrain
      for (const t of tiles) {
        if (t.terrain === def) continue;
        const cellOx = Math.floor(t.x / 3) * 3;
        const cellOy = Math.floor(t.y / 3) * 3;
        for (let dx = 0; dx < 3; dx++) {
          for (let dy = 0; dy < 3; dy++) {
            const key = `${cellOx + dx},${cellOy + dy}`;
            expect(
              tileMap.get(key),
              `${id}: tile (${t.x},${t.y}) is rare ${t.terrain} but cluster member (${cellOx + dx},${cellOy + dy}) missing/different`,
            ).toBe(t.terrain);
          }
        }
      }
    }
  });

  it('terrainAt observes live spec mutations AND routes per-constituent (§3.6)', () => {
    // Pins TWO invariants of `attachTerrainAt`:
    //   (a) BY-REFERENCE closure — it reads `spec.extraEllipses` live, so a §3.6
    //       merge that mutates the array is observed on the next call. A refactor
    //       to `{ ...spec, terrainAt }` would freeze the snapshot and fail here.
    //   (b) PER-CONSTITUENT terrain — a tile inside an absorbed lobe is generated
    //       under the LOBE's own biome + seed in the LOBE's local frame, NOT the
    //       absorber's. Discriminated by giving the lobe a DESERT biome over a
    //       PLAINS primary: desert never yields plains' 'grass' default.
    const spec = attachTerrainAt({
      id: 'closure-ref-test',
      name: 'closure-ref-test',
      biome: 'plains',
      cx: 0,
      cy: 0,
      majorRadius: 14,
      minorRadius: 14,
      populated: false,
      discovered: false,
      buildings: [],
      modifiers: [],
    });
    // Probe (24, 0) is fully outside the primary r=14 ellipse (radius 24 > 14)
    // and fully inside an r=8 extra at offset (22, 0) (probe-local (2, 0)).
    const probeX = 24;
    const probeY = 0;
    // Pre-mutation: outside every constituent → primary plains fallback, the
    // boundary cluster cell is demoted to the default 'grass'.
    expect(spec.terrainAt!(probeX, probeY)).toBe('grass');
    // §3.6-style mutation: push a DESERT lobe (own biome + seed) covering the
    // probe's cluster cell.
    spec.extraEllipses = [
      { biome: 'desert', originId: 'lobe-seed', major: 8, minor: 8, rotation: 0, offsetX: 22, offsetY: 0 },
    ];
    // What the lobe generates at its OWN local coords, under its OWN biome+seed,
    // with its OWN inscription predicate (r=8). The by-reference + per-constituent
    // closure MUST return exactly this.
    const expected = terrainAtForBiome('desert', 'lobe-seed', probeX - 22, probeY - 0, (px, py) =>
      tileInscribedInEllipse(px, py, 8, 8),
    );
    // Discrimination guard: desert terrain can never be plains' 'grass'. If this
    // ever became 'grass' the test would be vacuous (pre == post).
    expect(expected, 'desert lobe must not yield plains grass').not.toBe('grass');
    expect(spec.terrainAt!(probeX, probeY)).toBe(expected);
  });

  describe('per-constituent terrain after §3.6 merge', () => {
    function build(over: Partial<Parameters<typeof attachTerrainAt>[0]> & { id: string }) {
      return attachTerrainAt({
        name: over.id,
        biome: 'plains',
        cx: 0,
        cy: 0,
        majorRadius: 14,
        minorRadius: 14,
        populated: true,
        discovered: true,
        buildings: [],
        modifiers: [],
        ...over,
      });
    }

    it('an absorbed lobe reproduces its standalone terrain tile-for-tile (veins kept)', () => {
      // The lobe sits clear of the primary (centre dist ≈ 44 > 28 + 12), so there
      // is no overlap to muddy the comparison.
      const OX = 27;
      const OY = -35;
      const standalone = build({ id: 'gen', biome: 'desert', majorRadius: 12, minorRadius: 12 });
      const merged = build({
        id: 'home',
        biome: 'plains',
        majorRadius: 28,
        minorRadius: 28,
        extraEllipses: [{ biome: 'desert', originId: 'gen', major: 12, minor: 12, rotation: 0, offsetX: OX, offsetY: OY }],
      });
      let checked = 0;
      let veins = 0;
      for (let ly = -12; ly <= 12; ly++) {
        for (let lx = -12; lx <= 12; lx++) {
          if (!tileInscribedInEllipse(lx, ly, 12, 12)) continue;
          checked++;
          const got = merged.terrainAt!(lx + OX, ly + OY);
          expect(got).toBe(standalone.terrainAt!(lx, ly));
          if (got !== 'sand') veins++;
        }
      }
      expect(checked).toBeGreaterThan(100);
      // The lobe genuinely carries non-default (vein) terrain — otherwise the
      // tile-for-tile match would be a vacuous all-'sand' comparison.
      expect(veins).toBeGreaterThan(0);
    });

    it('the lobe seed matters — a different originId yields different terrain', () => {
      const OX = 27;
      const OY = -35;
      const a = build({
        id: 'home',
        biome: 'plains',
        majorRadius: 28,
        minorRadius: 28,
        extraEllipses: [{ biome: 'desert', originId: 'seed-A', major: 12, minor: 12, rotation: 0, offsetX: OX, offsetY: OY }],
      });
      const b = build({
        id: 'home',
        biome: 'plains',
        majorRadius: 28,
        minorRadius: 28,
        extraEllipses: [{ biome: 'desert', originId: 'seed-B', major: 12, minor: 12, rotation: 0, offsetX: OX, offsetY: OY }],
      });
      let diff = 0;
      for (let ly = -12; ly <= 12; ly++) {
        for (let lx = -12; lx <= 12; lx++) {
          if (!tileInscribedInEllipse(lx, ly, 12, 12)) continue;
          if (a.terrainAt!(lx + OX, ly + OY) !== b.terrainAt!(lx + OX, ly + OY)) diff++;
        }
      }
      expect(diff).toBeGreaterThan(0);
    });

    it('overlap resolves to the earliest constituent (primary wins a shared tile)', () => {
      // A lobe whose ellipse overlaps the primary: a tile inside BOTH must take
      // the PRIMARY's biome (plains), not the lobe's (desert) — "already placed"
      // / earliest-constituent precedence, matching the computeIslandTiles dedup.
      const merged = build({
        id: 'home',
        biome: 'plains',
        majorRadius: 14,
        minorRadius: 14,
        extraEllipses: [{ biome: 'desert', originId: 'gen', major: 14, minor: 14, rotation: 0, offsetX: 4, offsetY: 0 }],
      });
      // (0,0) is inside both the primary (r14 @ origin) and the lobe (r14 @ (4,0)).
      expect(tileInscribedInEllipse(0, 0, 14, 14)).toBe(true);
      expect(tileInscribedInEllipse(0 - 4, 0, 14, 14)).toBe(true);
      const primaryHere = terrainAtForBiome('plains', 'home', 0, 0, (px, py) =>
        tileInscribedInEllipse(px, py, 14, 14),
      );
      expect(merged.terrainAt!(0, 0)).toBe(primaryHere);
    });
  });
});

describe('rerollModifiers', () => {
  it('never includes natural-only modifiers', () => {
    for (let i = 0; i < 200; i++) {
      const mods = rerollModifiers('test', 'plains');
      expect(mods.includes('aetheric_anomaly')).toBe(false);
      expect(mods.includes('frozen_core')).toBe(false);
    }
  });

  it('can still return normal modifiers', () => {
    // Over many rolls on a biome that supports many modifiers, we should
    // see at least one non-empty result. Vary the seed so the rng isn't
    // identical across iterations that land in the same millisecond.
    let sawNonEmpty = false;
    for (let i = 0; i < 1000; i++) {
      const mods = rerollModifiers(`test-${i}`, 'plains');
      if (mods.length > 0) {
        sawNonEmpty = true;
        break;
      }
    }
    expect(sawNonEmpty).toBe(true);
  });
});
