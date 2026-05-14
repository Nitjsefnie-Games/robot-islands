// Biome definitions + modifier system per SPEC §3.2 / §3.5.
//
// Pure-logic module: no PixiJS, no DOM. Mirrors the `effectiveSkillMultipliers`
// pattern in `skilltree.ts` — a catalog of definitions plus a fold function
// that aggregates the active set into a multiplier bundle consumed by
// `computeRates` in `economy.ts`.
//
// Step 8 wires modifier effects through to the economy:
//   - mineral_rich      → +25% on extraction-tagged recipes
//   - fertile           → +50% on extraction-tagged recipes (forestry per §3.5;
//                         we don't yet differentiate forestry from other extraction
//                         so they share the wire — documented as a simplification)
//   - cursed_storms     → -10% on ALL recipe rates (global multiplier)
//   - stable            → no-op (1.0); tracked so future event systems know to
//                         skip negative rolls on this island
//   - high_wind         → outputVariance = true (±20% variance wired)
//   - geothermal_active → free heat to all requiresHeat buildings (heat.ts)
//   - aetheric_anomaly  → T5 raw extraction +50% rate (economy.ts)
//   - frozen_core       → cryo recipes 2× rate (economy.ts)
//
// All eight modifiers are now active; none remain structural placeholders.
//
// Modifier RANDOM GENERATION (`rollModifiers`) is exported for future-step use
// (artificial islands / new colonies / persisted seed worlds). Step 8 does
// NOT call it — `world.ts` `DEMO_ISLANDS` carries hand-assigned modifier lists.
// The function is fully implemented and tested so the API exists when step 11
// arrives.

import type { Biome } from './world.js';
import { defaultTerrainAt, type TerrainKind } from './island.js';
import type { RecipeCategory } from './recipes.js';
import { ALL_RECIPE_CATEGORIES } from './recipes.js';
import { makeSeededRng } from './rng.js';

// ---------------------------------------------------------------------------
// Biome catalog
// ---------------------------------------------------------------------------

export interface BiomeDef {
  readonly id: Biome;
  /** SPEC §3.4 initial major radius in tiles. */
  readonly initialMajorRadius: number;
  /** SPEC §3.4 initial minor radius in tiles. */
  readonly initialMinorRadius: number;
  /** SPEC §3.2 power source. Currently informational — Wind Turbine /
   *  Geothermal Vent / Cryogenic Generator buildings are not yet implemented. */
  readonly powerSource: 'solar' | 'biomass' | 'wind' | 'geothermal' | 'cryogenic';
  /** Default tile color across the island's open buildable terrain. */
  readonly defaultTerrain: TerrainKind;
  /** Tile types that can appear as scattered veins/clusters. The exact
   *  distribution lives in `terrainAtForBiome` — we keep the candidate set
   *  here so the data model documents biome-typical rare resources. */
  readonly rareTerrain: ReadonlyArray<TerrainKind>;
  readonly displayName: string;
}

/**
 * Per-biome static definition. Values from SPEC §3.2 / §3.4. The home island
 * uses the Plains values. Per-biome `terrainAtForBiome` consumes the
 * defaultTerrain and rareTerrain fields when generating non-home islands.
 */
export const BIOME_DEFS: Readonly<Record<Biome, BiomeDef>> = {
  plains: {
    id: 'plains',
    initialMajorRadius: 14,
    initialMinorRadius: 14,
    powerSource: 'solar',
    defaultTerrain: 'grass',
    // §8.1 bootstrap: Plains needs Logger access (tree) and stone access.
    // Procedurally-settled Plains colonies inherit these rares via
    // terrainAtForBiome scatter (not clustered, but present so 1x1 Loggers
    // and singletons of stone are placeable).
    rareTerrain: ['tree', 'stone', 'ore', 'coal'],
    displayName: 'Plains',
  },
  forest: {
    id: 'forest',
    initialMajorRadius: 10,
    initialMinorRadius: 10,
    powerSource: 'biomass',
    defaultTerrain: 'grass',
    // §3.2 lists "tree, dense forest, grass, water" — tree first. Step 8
    // keeps grass as default for buildability (the Logger that clears tree
    // doesn't ship until a later step) and uses tree as a visual accent so
    // the biome reads distinct. Tree/water are weighted 2× in rareTerrain.
    rareTerrain: ['tree', 'tree', 'stone', 'water'],
    displayName: 'Forest',
  },
  coast: {
    id: 'coast',
    initialMajorRadius: 14,
    initialMinorRadius: 7,
    powerSource: 'wind',
    defaultTerrain: 'sand',
    rareTerrain: ['water', 'water', 'ore', 'oil_well', 'gas_seep'],
    displayName: 'Coast',
  },
  volcanic: {
    id: 'volcanic',
    initialMajorRadius: 7,
    initialMinorRadius: 7,
    powerSource: 'geothermal',
    defaultTerrain: 'stone',
    rareTerrain: ['magma_vent', 'coal', 'ore', 'gas_seep', 'helium_vent'],
    displayName: 'Volcanic',
  },
  desert: {
    id: 'desert',
    initialMajorRadius: 12,
    initialMinorRadius: 12,
    powerSource: 'solar',
    defaultTerrain: 'sand',
    rareTerrain: ['stone', 'ore', 'oil_well'],
    displayName: 'Desert',
  },
  arctic: {
    id: 'arctic',
    initialMajorRadius: 10,
    initialMinorRadius: 10,
    powerSource: 'cryogenic',
    defaultTerrain: 'stone',
    // Arctic uses `ice` as scattered cryo deposit (cryo recipes not implemented).
    rareTerrain: ['ice', 'ice', 'stone', 'helium_vent'],
    displayName: 'Arctic',
  },
};

// ---------------------------------------------------------------------------
// Modifier catalog (§3.5)
// ---------------------------------------------------------------------------

export type ModifierId =
  | 'high_wind'
  | 'geothermal_active'
  | 'mineral_rich'
  | 'cursed_storms'
  | 'stable'
  | 'aetheric_anomaly'
  | 'frozen_core'
  | 'fertile';

/** Visual category for the UI chip color. Pure data — no DOM/PixiJS. */
export type ModifierCategory = 'positive' | 'warning' | 'exotic' | 'neutral';

export interface ModifierDef {
  readonly id: ModifierId;
  readonly displayName: string;
  readonly description: string;
  /** §3.5 base weight for the rarity roll. */
  readonly weight: number;
  /** Biomes this modifier can roll on. Empty array means "all biomes". */
  readonly biomeRestriction: ReadonlyArray<Biome>;
  /** Per-biome weight multiplier for biome-favored rolls. The Geothermal
   *  Active case in §3.5: 12 on Volcanic, 3 elsewhere — encoded as `volcanic: 2,
   *  others-default 0.5`. Missing biome ⇒ 1× (no scaling). */
  readonly biomeWeightMul?: Readonly<Partial<Record<Biome, number>>>;
  /** Step-8 placeholder: appears in catalog + UI but has no economic effect
   *  (the system it depends on is not yet implemented). */
  readonly placeholder: boolean;
  /** UI category for chip colour. */
  readonly category: ModifierCategory;
  /** True for modifiers that can only appear on natural (non-artificial) islands
   *  and are excluded from Reality Forge rerolls. */
  readonly naturalOnly?: boolean;
}

export const MODIFIER_DEFS: Readonly<Record<ModifierId, ModifierDef>> = {
  high_wind: {
    id: 'high_wind',
    displayName: 'High Wind',
    description: 'Wind power +50%, but all output has ±20% random variance.',
    weight: 10,
    biomeRestriction: [],
    placeholder: false, // Variance machinery wired; wind-power +50% deferred.
    category: 'warning',
  },
  geothermal_active: {
    id: 'geothermal_active',
    displayName: 'Geothermal Active',
    description: 'Free heat to all buildings; no need for adjacent heat source.',
    weight: 6,
    biomeRestriction: [],
    // §3.5: weight 12 on Volcanic, 3 elsewhere — i.e. ×2 on Volcanic, ×0.5 elsewhere.
    biomeWeightMul: {
      plains: 0.5,
      forest: 0.5,
      coast: 0.5,
      volcanic: 2,
      desert: 0.5,
      arctic: 0.5,
    },
    placeholder: false, // Wired in heat.ts: free heat for all requiresHeat buildings.
    category: 'exotic',
  },
  mineral_rich: {
    id: 'mineral_rich',
    displayName: 'Mineral Rich',
    description: '+25% raw extraction on this island.',
    weight: 10,
    biomeRestriction: [],
    placeholder: false,
    category: 'positive',
  },
  cursed_storms: {
    id: 'cursed_storms',
    displayName: 'Cursed Storms',
    description: '-10% production overall, but rare resource finds doubled.',
    weight: 3,
    biomeRestriction: [],
    placeholder: false, // -10% is wired; doubled-rare is deferred (no rare-find rolls yet).
    category: 'warning',
  },
  stable: {
    id: 'stable',
    displayName: 'Stable',
    description: 'No negative modifiers, no random events.',
    weight: 5,
    biomeRestriction: [],
    placeholder: false, // Mechanically a 1.0 multiplier — but tracked so future
                        // event/storm systems know to skip negative rolls.
    category: 'neutral',
  },
  aetheric_anomaly: {
    id: 'aetheric_anomaly',
    displayName: 'Aetheric Anomaly',
    description: 'T5 raw extraction +50% on this island.',
    weight: 1,
    biomeRestriction: [],
    placeholder: false,
    category: 'exotic',
    naturalOnly: true,
  },
  frozen_core: {
    id: 'frozen_core',
    displayName: 'Frozen Core',
    description: 'Cryo recipes 2× efficient.',
    weight: 6,
    biomeRestriction: ['arctic'],
    placeholder: false, // Wired in economy.ts: cryo recipes 2× rate.
    category: 'exotic',
    naturalOnly: true,
  },
  fertile: {
    id: 'fertile',
    displayName: 'Fertile',
    description: 'Forestry +50% (treated as extraction in step 8).',
    weight: 6,
    biomeRestriction: [],
    placeholder: false,
    category: 'positive',
  },
};

/** Useful for iteration — preserves catalog declaration order. */
export const ALL_MODIFIERS: ReadonlyArray<ModifierId> = [
  'high_wind',
  'geothermal_active',
  'mineral_rich',
  'cursed_storms',
  'stable',
  'aetheric_anomaly',
  'frozen_core',
  'fertile',
];

// ---------------------------------------------------------------------------
// Effect aggregation (mirrors `effectiveSkillMultipliers` in skilltree.ts)
// ---------------------------------------------------------------------------

export interface ModifierMultipliers {
  /** Multiplier on every recipe rate, regardless of category. From global
   *  modifiers like cursed_storms. Composes BEFORE per-category multipliers. */
  readonly globalRecipeRate: number;
  /** Per-category multiplier composed on top of `globalRecipeRate`. */
  readonly recipeRateByCategory: Readonly<Record<RecipeCategory, number>>;
  /** If true, apply ±20% variance to all recipe outputs. */
  readonly outputVariance: boolean;
  /** §8.10 Aetheric Anomaly: +50% T5 extractor rate. */
  readonly t5ExtractionRateMul: number;
  /** §3.5 Frozen Core: 2× cryo recipe rate. */
  readonly cryoRecipeRateMul: number;
}

function blankModifierMultipliers(): ModifierMultipliers {
  const recipeRateByCategory = {} as Record<RecipeCategory, number>;
  for (const c of ALL_RECIPE_CATEGORIES) recipeRateByCategory[c] = 1;
  return { globalRecipeRate: 1, recipeRateByCategory, outputVariance: false, t5ExtractionRateMul: 1, cryoRecipeRateMul: 1 };
}

/** Identity bundle, exported so callers (`computeRates`, tests) have a
 *  named "no modifiers" value rather than reconstructing the shape inline. */
export const IDENTITY_MODIFIER_MULTIPLIERS: ModifierMultipliers = blankModifierMultipliers();

/**
 * Fold a modifier list into a multiplier bundle. Pure: handles the empty-list
 * case (returns a fresh identity bundle), and silently ignores unknown ids.
 *
 * Active §3.5 modifier effects:
 *   - mineral_rich    → recipeRateByCategory.extraction × 1.25
 *   - fertile         → recipeRateByCategory.extraction × 1.50
 *                       (composes with mineral_rich; both target extraction)
 *   - cursed_storms   → globalRecipeRate × 0.90
 *   - stable          → no-op (recorded for future event-system gates)
 *   - high_wind       → outputVariance = true
 *   - geothermal_active → no numeric multiplier (structural; handled in heat.ts)
 *   - aetheric_anomaly  → t5ExtractionRateMul × 1.50
 *   - frozen_core       → cryoRecipeRateMul × 2.0
 */
export function effectiveModifierMultipliers(
  modifiers: ReadonlyArray<ModifierId>,
): ModifierMultipliers {
  const out = blankModifierMultipliers();
  // Mutable view — readonly is the consumer contract, not the local builder.
  const cat = out.recipeRateByCategory as Record<RecipeCategory, number>;
  let global = out.globalRecipeRate;
  let outputVariance = out.outputVariance;
  let t5ExtractionRateMul = out.t5ExtractionRateMul;
  let cryoRecipeRateMul = out.cryoRecipeRateMul;
  for (const id of modifiers) {
    switch (id) {
      case 'mineral_rich':
        cat.extraction = (cat.extraction ?? 1) * 1.25;
        break;
      case 'fertile':
        cat.extraction = (cat.extraction ?? 1) * 1.50;
        break;
      case 'cursed_storms':
        global *= 0.9;
        break;
      case 'high_wind':
        outputVariance = true;
        break;
      case 'stable':
      case 'geothermal_active':
        break;
      case 'aetheric_anomaly':
        t5ExtractionRateMul *= 1.5;
        break;
      case 'frozen_core':
        cryoRecipeRateMul *= 2;
        break;
      default: {
        // Exhaustiveness guard — adding a new ModifierId without wiring its
        // effect here becomes a compile error rather than a silent no-op.
        const _exhaustive: never = id;
        void _exhaustive;
        break;
      }
    }
  }
  return { globalRecipeRate: global, recipeRateByCategory: cat, outputVariance, t5ExtractionRateMul, cryoRecipeRateMul };
}

// ---------------------------------------------------------------------------
// Modifier random generation (deferred from step 8 — exported for step 11+)
// ---------------------------------------------------------------------------

/** §3.5: 50% → 0 modifiers, 30% → 1, 15% → 2, 5% → 3. */
const COUNT_THRESHOLDS: ReadonlyArray<{ readonly count: number; readonly cumulative: number }> = [
  { count: 0, cumulative: 0.50 },
  { count: 1, cumulative: 0.80 },
  { count: 2, cumulative: 0.95 },
  { count: 3, cumulative: 1.00 },
];

function rollCount(rng: () => number): number {
  const r = rng();
  for (const t of COUNT_THRESHOLDS) {
    if (r < t.cumulative) return t.count;
  }
  // Floating-point edge: r could be exactly 1.0 in theory; the `<` above
  // would miss it. Fall through to the highest bucket.
  return 3;
}

/** Effective weight of a modifier on a given biome. Returns 0 if the
 *  modifier's biomeRestriction excludes this biome. */
function effectiveWeight(def: ModifierDef, biome: Biome): number {
  if (def.biomeRestriction.length > 0 && !def.biomeRestriction.includes(biome)) {
    return 0;
  }
  const mul = def.biomeWeightMul?.[biome] ?? 1;
  return def.weight * mul;
}

/** Weighted sample WITHOUT replacement from `pool`, returning the picked id. */
function weightedSample(
  pool: ReadonlyArray<ModifierId>,
  biome: Biome,
  rng: () => number,
): ModifierId | null {
  let total = 0;
  for (const id of pool) total += effectiveWeight(MODIFIER_DEFS[id], biome);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const id of pool) {
    const w = effectiveWeight(MODIFIER_DEFS[id], biome);
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return id;
  }
  // Floating-point safety: return the last positive-weight pool member.
  for (let i = pool.length - 1; i >= 0; i--) {
    const id = pool[i]!;
    if (effectiveWeight(MODIFIER_DEFS[id], biome) > 0) return id;
  }
  return null;
}

/**
 * Generate a modifier set per §3.5 rules.
 *
 * Algorithm:
 *   1. Sample count from the {0:50, 1:30, 2:15, 3:5} distribution.
 *   2. If count = 0 → return [].
 *   3. First draw considers the FULL pool (Stable included) with biome-adjusted
 *      weights. If first draw is Stable → return ['stable'] (the modifier count
 *      collapses to 1, regardless of original count roll).
 *   4. If first draw is non-Stable → remove Stable from the pool and continue
 *      drawing without replacement until `count` is reached or the pool dries up.
 *
 * `seed` is advisory in step 8 — `rng` is the actual entropy source. Future
 * persisted-world generation will combine seed + island id into the rng
 * upstream of this function. Currently kept on the signature for forward-compat.
 */
export function rollModifiers(
  _seed: string,
  biome: Biome,
  rng: () => number,
): ModifierId[] {
  const count = rollCount(rng);
  if (count <= 0) return [];

  // Build initial pool: all modifiers whose biomeRestriction admits this biome.
  // Modifiers excluded by biome get effective weight 0, but excluding them
  // up-front simplifies the without-replacement bookkeeping.
  const initialPool: ModifierId[] = [];
  for (const id of ALL_MODIFIERS) {
    if (effectiveWeight(MODIFIER_DEFS[id], biome) > 0) initialPool.push(id);
  }
  if (initialPool.length === 0) return [];

  // First draw — Stable still in the pool.
  const first = weightedSample(initialPool, biome, rng);
  if (first === null) return [];
  if (first === 'stable') return ['stable'];

  // Subsequent draws — Stable banned (§3.5 mutual exclusivity).
  const result: ModifierId[] = [first];
  const remaining = initialPool.filter((id) => id !== 'stable' && id !== first);
  for (let i = 1; i < count; i++) {
    if (remaining.length === 0) break;
    const next = weightedSample(remaining, biome, rng);
    if (next === null) break;
    result.push(next);
    const idx = remaining.indexOf(next);
    if (idx >= 0) remaining.splice(idx, 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Per-biome terrain generation
// ---------------------------------------------------------------------------

/**
 * Cheap deterministic hash of (islandId, x, y) → uniform [0, 1). Pure
 * function. Same input always returns same output. Used to scatter rare
 * tiles deterministically without a heavy seeded-RNG module.
 *
 * Algorithm: classic FNV-1a-style mix on a string built from the inputs.
 * Quality is fine for visual scatter; we are not using this for stat-tests.
 */
function tileHash01(islandId: string, x: number, y: number): number {
  let h = 2166136261 >>> 0;
  const s = `${islandId}:${x},${y}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Fold to [0, 1).
  return ((h >>> 0) % 1_000_003) / 1_000_003;
}

/**
 * Compute the terrain at island-local (x, y) for a given biome. Pure function.
 *
 * Special case: if `islandId === 'home'` we delegate to the hand-placed
 * `defaultTerrainAt` from `island.ts` to preserve the existing visual layout
 * exactly (Mine sits on a specific ore-cluster the user already saw). Other
 * islands get biome-typed default + scattered rares from the catalog.
 *
 * The caller is `world.ts`, which composes this with each demo island's id
 * + biome. The function does NOT take an IslandSpec to keep the dependency
 * arrow `world.ts → biomes.ts` (not the other way).
 */
/**
 * Reroll modifiers for a biome change via Reality Forge. Excludes natural-only
 * modifiers (aetheric_anomaly, frozen_core) per §13.3.
 */
export function rerollModifiers(seed: string, biome: Biome): ModifierId[] {
  const rng = makeSeededRng(`${seed}_reroll_${biome}_${Date.now()}`);
  const result = rollModifiers(seed, biome, rng);
  return result.filter((id) => !MODIFIER_DEFS[id].naturalOnly);
}

export function terrainAtForBiome(
  biome: Biome,
  islandId: string,
  x: number,
  y: number,
): TerrainKind {
  // Preserve home island's hand-placed layout exactly.
  if (islandId === 'home') {
    return defaultTerrainAt(x, y);
  }
  const def = BIOME_DEFS[biome];
  const r = tileHash01(islandId, x, y);
  // ~12% of tiles get a rare type. The default terrain dominates so the
  // biome's "look" is unmistakable at a glance.
  const RARE_DENSITY = 0.12;
  if (r < RARE_DENSITY && def.rareTerrain.length > 0) {
    // Sample a rare from the rareTerrain list deterministically. Repeated
    // entries in the list (Forest's two `tree`s) skew the distribution.
    const idx = Math.floor((r / RARE_DENSITY) * def.rareTerrain.length);
    const safeIdx = Math.min(idx, def.rareTerrain.length - 1);
    return def.rareTerrain[safeIdx]!;
  }
  return def.defaultTerrain;
}

