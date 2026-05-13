// Pure-logic tests for the biome + modifier system per SPEC §3.2 / §3.5.
//
// Tests cover:
//   - BIOME_DEFS / MODIFIER_DEFS catalog completeness
//   - rollModifiers determinism with a seeded LCG
//   - Stable mutual exclusivity (both branches: first-Stable collapse, and
//     Stable-banned-from-subsequent-draws when first is non-Stable)
//   - Biome restriction (frozen_core only on Arctic)
//   - effectiveModifierMultipliers fold (active + placeholder + composition)
//   - terrainAtForBiome determinism + biome differentiation + home identity

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
  type ModifierId,
} from './biomes.js';
import { defaultTerrainAt, tileInscribedInEllipse, type TerrainKind } from './island.js';
import type { Biome } from './world.js';

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
  it('marks the two step-8 placeholders as placeholder=true', () => {
    expect(MODIFIER_DEFS.geothermal_active.placeholder).toBe(true);
    expect(MODIFIER_DEFS.frozen_core.placeholder).toBe(true);
  });
  it('marks the six wired modifiers as placeholder=false', () => {
    expect(MODIFIER_DEFS.high_wind.placeholder).toBe(false);
    expect(MODIFIER_DEFS.mineral_rich.placeholder).toBe(false);
    expect(MODIFIER_DEFS.fertile.placeholder).toBe(false);
    expect(MODIFIER_DEFS.cursed_storms.placeholder).toBe(false);
    expect(MODIFIER_DEFS.stable.placeholder).toBe(false);
    expect(MODIFIER_DEFS.aetheric_anomaly.placeholder).toBe(false);
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
    // Force count=3 (rng=0.96 → cumulative bucket 3), then force Stable on first draw.
    // Stable-mutual-exclusivity must collapse the result to ['stable'].
    let i = 0;
    const seq = [0.96 /* count=3 */, /* first draw via cumulative weighted: trick by giving small r */ 0.0001];
    const rng = (): number => {
      const v = seq[i] ?? 0;
      i += 1;
      return v;
    };
    // The first weighted-sample call uses rng() * total. With r close to 0,
    // the first non-zero-weight modifier in the iteration order is picked.
    // Since high_wind is first in ALL_MODIFIERS, that would be picked — not
    // stable. Instead we use a synthetic test: monkey-patch by repeating
    // rolls until stable is selected with a known seed.
    //
    // Easier path: pick a seed where we KNOW the first draw is Stable, then
    // assert collapse. The deterministic LCG seed-search approach: try
    // seeds 0..99 and find one where rollModifiers on plains returns ['stable'].
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

  it('placeholder modifiers contribute no multiplier change', () => {
    const placeholders: ModifierId[] = [
      'geothermal_active',
      'aetheric_anomaly',
      'frozen_core',
    ];
    const m = effectiveModifierMultipliers(placeholders);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
    expect(m.outputVariance).toBe(false);
  });

  it('high_wind sets outputVariance=true and leaves rates unchanged', () => {
    const m = effectiveModifierMultipliers(['high_wind']);
    expect(m.globalRecipeRate).toBe(1);
    for (const c of Object.values(m.recipeRateByCategory)) expect(c).toBe(1);
    expect(m.outputVariance).toBe(true);
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
  });
});

describe('terrainAtForBiome', () => {
  it('is deterministic given the same (islandId, x, y)', () => {
    const a = terrainAtForBiome('forest', 'forest-1', 3, -2);
    const b = terrainAtForBiome('forest', 'forest-1', 3, -2);
    expect(a).toBe(b);
  });

  it('preserves the home island layout exactly', () => {
    // Sweep every (x,y) inside the radius-14 ellipse and assert identity
    // with `defaultTerrainAt`. This is the load-bearing invariant: home
    // looks unchanged from step-1.
    for (let y = -14; y <= 14; y++) {
      for (let x = -14; x <= 14; x++) {
        if (!tileInscribedInEllipse(x, y, 14, 14)) continue;
        expect(
          terrainAtForBiome('plains', 'home', x, y),
          `home (${x},${y}) drift`,
        ).toBe(defaultTerrainAt(x, y));
      }
    }
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
          const t = terrainAtForBiome(b, `test-${b}`, x, y);
          counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      // Find the most common.
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
    const a = terrainAtForBiome('forest', 'a', 0, 0);
    const b = terrainAtForBiome('desert', 'a', 0, 0);
    // We don't require !== (could collide if both pick a shared rare like
    // stone), so the stronger property is "the default-terrain swap shows
    // up across many points."
    void a;
    void b;
    let differences = 0;
    for (let y = -5; y <= 5; y++) {
      for (let x = -5; x <= 5; x++) {
        const fa = terrainAtForBiome('forest', 'X', x, y);
        const da = terrainAtForBiome('desert', 'X', x, y);
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
      for (let y = -12; y <= 12; y++) {
        for (let x = -12; x <= 12; x++) {
          if (terrainAtForBiome(biome, `scan-${kind}`, x, y) === kind) return true;
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
