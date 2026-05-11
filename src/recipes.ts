// Resources, recipes, and xp_weight table.
//
// Per SPEC §6 (Resource Catalog) and §7 (Recipe Chains). Step 9 expands the
// catalog from the step-3 Mine+Workshop chain to the partial §7.1 Iron/Steel
// pipeline plus a forestry/biomass loop. Step 12 extends into the T4
// endgame chain (§6.5) — five new resources fed by the new T4 buildings:
//
//   T0/T1 raws:   wood, iron_ore, coal, biofuel
//   T1 refined:   iron_ingot, coke, pig_iron, bolt
//   T2 alloy:     steel
//   T2 component: gear
//   T4 raw/fuel:  helium_3, cryogenic_hydrogen
//   T4 component: quantum_chip, exotic_alloy, ai_core
//
// Step-13 (T5 Transcendent, §6.6) adds a partial T5 catalog — just enough
// to drive the Reality Forge chain + T5 fuel:
//
//   T5 raw:       casimir_energy   (per §8.10 Casimir Tap "free vacuum energy")
//   T5 fuel:      plasma_charge    (T5 propellant per §6.6 / §11.7)
//   T5 component: reality_anchor, eldritch_processor, phase_converter
//
// Full §6.6 T5 raw catalog (Dark matter, Zero-point flux, Tachyon stream,
// Neutronium, Strange matter, Higgs flux, Quantum foam, Aetheric current,
// Spacetime fragment) is DEFERRED to step 14 — only the resources the
// Reality Forge / Casimir Tap demo recipes consume ship in step 13.
//
// `xp_weight` per SPEC §9.1: T0 raws = 1, T1 = 3, T2 = 10, T4 = 100, T5 = 300.
// Higher-tier outputs grant proportionally more XP per unit produced, so the
// progression curve rewards climbing the recipe chain rather than just
// stockpiling raws.

import type { BuildingDef, BuildingDefId } from './building-defs.js';
import type { PlacedBuilding } from './buildings.js';
import type { TerrainKind } from './island.js';

export type ResourceId =
  // T0 raws
  | 'wood'
  | 'iron_ore'
  | 'coal'
  // T1 refined
  | 'biofuel'
  | 'iron_ingot'
  | 'coke'
  | 'pig_iron'
  | 'bolt'
  // T2 alloy / component
  | 'steel'
  | 'gear'
  // T1 composite (§12.3 Foundation Kit). Standard variant only — Enriched/
  // Refined per-tier variants deferred. The kit is a single inventory item;
  // its decomposition into raw constituents on arrival (§12.4) is deferred.
  | 'foundation_kit'
  // T4 endgame (§6.5)
  | 'helium_3'
  | 'cryogenic_hydrogen'
  | 'quantum_chip'
  | 'exotic_alloy'
  | 'ai_core'
  // T5 transcendent (§6.6) — partial step-13 catalog (raws/components needed
  // for the Reality Forge demo chain + T5 fuel). Full §6.6 raws deferred.
  | 'casimir_energy'
  | 'reality_anchor'
  | 'plasma_charge'
  | 'eldritch_processor'
  | 'phase_converter';

/** All known resources, useful for iterating to initialise inventories. */
export const ALL_RESOURCES: ReadonlyArray<ResourceId> = [
  'wood',
  'iron_ore',
  'coal',
  'biofuel',
  'iron_ingot',
  'coke',
  'pig_iron',
  'bolt',
  'steel',
  'gear',
  'foundation_kit',
  'helium_3',
  'cryogenic_hydrogen',
  'quantum_chip',
  'exotic_alloy',
  'ai_core',
  // T5 transcendent (§6.6) — step-13 partial catalog
  'casimir_energy',
  'reality_anchor',
  'plasma_charge',
  'eldritch_processor',
  'phase_converter',
];

/**
 * XP weight per resource, per SPEC §9.1 (tier-weighted production).
 *   T0 raw       = 1   (wood, iron_ore, coal)
 *   T1 refined   = 3   (biofuel, iron_ingot, coke, pig_iron)
 *   T2 alloy /   = 10  (bolt, steel, gear)
 *      component
 *   T4 endgame   = 100 (helium_3, cryogenic_hydrogen, quantum_chip,
 *                       exotic_alloy, ai_core)
 *   T5 transcendent = 300 (casimir_energy, reality_anchor, plasma_charge,
 *                          eldritch_processor, phase_converter)
 */
export const XP_WEIGHT: Readonly<Record<ResourceId, number>> = {
  // T0 raws
  wood: 1,
  iron_ore: 1,
  coal: 1,
  // T1 refined
  biofuel: 3,
  iron_ingot: 3,
  coke: 3,
  pig_iron: 3,
  // T2 alloy / component
  bolt: 10,
  steel: 10,
  gear: 10,
  // T1 composite (§12.3). xp_weight 10 — task brief assigns the kit the same
  // weight as T2 components since one kit represents a non-trivial assembly.
  foundation_kit: 10,
  // T4 endgame (§6.5)
  helium_3: 100,
  cryogenic_hydrogen: 100,
  quantum_chip: 100,
  exotic_alloy: 100,
  ai_core: 100,
  // T5 transcendent (§6.6) — partial step-13 catalog
  casimir_energy: 300,
  reality_anchor: 300,
  plasma_charge: 300,
  eldritch_processor: 300,
  phase_converter: 300,
};

/**
 * Recipe categories per SPEC §7.0 / §9.4. Skill-tree effects and (later)
 * Specialization-passive buffs target recipes by category tag, not by
 * building kind — this keeps edge cases (Cracker is petrochemical, not
 * strictly smelting) consistent. The full catalog in §7 has more tags;
 * step 9 needs the seven listed below.
 */
export type RecipeCategory =
  | 'extraction'
  | 'smelting'
  | 'chemistry'
  | 'manufacturing'
  | 'electronics'
  | 'power'
  | 'logistics';

/** All recipe categories, useful for initialising per-category records to 1.0. */
export const ALL_RECIPE_CATEGORIES: ReadonlyArray<RecipeCategory> = [
  'extraction',
  'smelting',
  'chemistry',
  'manufacturing',
  'electronics',
  'power',
  'logistics',
];

/**
 * A single recipe definition. `cycleSec` is the time for one production
 * cycle at base rate (rate = 1 / cycleSec). `inputs` lists per-cycle input
 * demand; `outputs` lists per-cycle output yield. Both are partial maps:
 * resources not listed are not involved. `category` tags the recipe for
 * skill-tree and specialization effects (§9.3/§9.4).
 */
export interface Recipe {
  readonly cycleSec: number;
  readonly inputs: Partial<Record<ResourceId, number>>;
  readonly outputs: Partial<Record<ResourceId, number>>;
  readonly category: RecipeCategory;
}

/**
 * A recipe id. Most ids match a `BuildingDefId` 1:1 — the recipe table is
 * keyed by the building that runs it. A few synthetic ids cover tile-variant
 * recipes for a single building kind, selected at runtime by
 * `resolveRecipe`:
 *
 *   - `mine_on_ore`  — Mine on an ore-vein footprint  → iron_ore
 *   - `mine_on_coal` — Mine on a coal-vein footprint → coal
 *
 * The legacy `mine` entry stays as a fallback recipe (= same as
 * `mine_on_ore`) so callers that don't pass a terrain closure into
 * `resolveRecipe` keep the pre-tile-aware behaviour.
 */
export type RecipeId = BuildingDefId | 'mine_on_ore' | 'mine_on_coal';

/**
 * Recipe binding by recipe id. Buildings without a recipe (Solar, Dock,
 * Crate, Silo, Tank, Drone Pad) are absent from the map.
 *
 * Step-9 chain (partial §7.1 Iron/Steel + auxiliaries):
 *
 *   T1 extraction:
 *     mine     -> 1 iron_ore  / 5s   (no inputs; fallback when no terrain
 *                                     closure is provided to resolveRecipe.
 *                                     Tile-aware callers receive
 *                                     mine_on_ore / mine_on_coal instead.)
 *     logger   -> 1 wood      / 4s   (no inputs; tile-req `tree` deferred)
 *
 *   T1 smelting / refining:
 *     smelter  -> 1 iron_ingot / 8s  from 1 iron_ore + 1 coal
 *
 *   T1 manufacturing:
 *     workshop -> 1 bolt      / 10s  from 1 iron_ore + 1 coal
 *
 *   T1 power-burn (no resource output; W on def.power.produces):
 *     coal_gen        -> burns 1 coal / 5s
 *     biomass_plant   -> burns 1 wood / 6s
 *
 *   T2 smelting / refining:
 *     coke_oven       -> 1 coke      / 10s from 1 coal
 *     blast_furnace   -> 1 pig_iron  / 12s from 1 iron_ingot + 1 coke
 *                        (§5.2 heat-source adjacency deferred)
 *     steel_mill      -> 1 steel     / 15s from 1 pig_iron
 *                        (§7.1 scrap co-input deferred)
 *
 *   T2 manufacturing:
 *     assembler       -> 1 gear      /  8s from 1 iron_ingot + 2 bolt
 *
 *   T3 smelting:
 *     electric_arc_furnace -> 1 steel / 6s from 1 pig_iron
 *                              (higher-throughput alternative to Steel Mill)
 */
export const RECIPES: Partial<Record<RecipeId, Recipe>> = {
  // T1 extraction
  // `mine` is the legacy / fallback Mine recipe (= mine_on_ore). Tile-aware
  // callers go through `resolveRecipe` and receive `mine_on_ore` or
  // `mine_on_coal` depending on the building's footprint terrain. The
  // bare-defId lookup is preserved for tests + saved games that never had
  // a tile-aware path.
  mine: {
    cycleSec: 5,
    inputs: {},
    outputs: { iron_ore: 1 },
    category: 'extraction',
  },
  // §8.1 Mine variants — tile-dependent recipe selection. The two entries
  // differ only in output: ore-vein footprint → iron_ore; coal-vein
  // footprint → coal. Inputs/cycleSec/category identical so a build-order
  // change in placement doesn't shift any other downstream rate.
  mine_on_ore: {
    cycleSec: 5,
    inputs: {},
    outputs: { iron_ore: 1 },
    category: 'extraction',
  },
  mine_on_coal: {
    cycleSec: 5,
    inputs: {},
    outputs: { coal: 1 },
    category: 'extraction',
  },
  logger: {
    cycleSec: 4,
    inputs: {},
    outputs: { wood: 1 },
    category: 'extraction',
  },

  // T1 smelting
  smelter: {
    cycleSec: 8,
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { iron_ingot: 1 },
    category: 'smelting',
  },

  // T1 manufacturing
  workshop: {
    cycleSec: 10,
    inputs: { iron_ore: 1, coal: 1 },
    outputs: { bolt: 1 },
    category: 'manufacturing',
  },

  // T1 power-burn (Coal Gen burns 1 coal/5s; W contribution lives on
  // def.power.produces, not in `outputs`). Empty `outputs` is intentional.
  coal_gen: {
    cycleSec: 5,
    inputs: { coal: 1 },
    outputs: {},
    category: 'power',
  },
  biomass_plant: {
    cycleSec: 6,
    inputs: { wood: 1 },
    outputs: {},
    category: 'power',
  },

  // T2 smelting
  coke_oven: {
    cycleSec: 10,
    inputs: { coal: 1 },
    outputs: { coke: 1 },
    category: 'smelting',
  },
  blast_furnace: {
    cycleSec: 12,
    inputs: { iron_ingot: 1, coke: 1 },
    outputs: { pig_iron: 1 },
    category: 'smelting',
  },
  steel_mill: {
    cycleSec: 15,
    inputs: { pig_iron: 1 },
    outputs: { steel: 1 },
    category: 'smelting',
  },

  // T2 manufacturing
  assembler: {
    cycleSec: 8,
    inputs: { iron_ingot: 1, bolt: 2 },
    outputs: { gear: 1 },
    category: 'manufacturing',
  },

  // T1 manufacturing — Kit Assembler (§12.3). Composite recipe producing
  // a single Foundation Kit per cycle. Spec's full Standard Foundation Kit
  // is `50 Iron ingot + 20 Brick + 10 Lumber + 5 Glass + 5 Gear`; step-12
  // simplifies the bill to resources already in the catalog (iron_ingot,
  // wood, bolt) since Brick/Glass aren't catalogued yet. The cycleSec (60s)
  // makes one kit a meaningful commitment compared to a 10s bolt or 8s gear.
  kit_assembler: {
    cycleSec: 60,
    inputs: { iron_ingot: 5, wood: 10, bolt: 5 },
    outputs: { foundation_kit: 1 },
    category: 'manufacturing',
  },

  // T3 smelting (higher-throughput steel alternative)
  electric_arc_furnace: {
    cycleSec: 6,
    inputs: { pig_iron: 1 },
    outputs: { steel: 1 },
    category: 'smelting',
  },

  // ---------------------------------------------------------------------------
  // T4 endgame chain (§6.5 / §7.11 / §8.2 / §9.5)
  // ---------------------------------------------------------------------------
  // Dependency arrow: particle_accelerator → quantum_chip
  //                   → cryogenic_compute_center (ARCTIC) → ai_core
  //                   pyroforge (VOLCANIC) → exotic_alloy (uses helium_3 fuel)
  //                   fusion_core → power-burn (uses helium_3 fuel)
  // helium_3 is a §6.4 T3 raw mined naturally (Vault terrain) — not produced
  // by any building in step 12. It is seeded on forest-ne for demo only.
  // The chain is NOT fully exercisable on forest-ne (no Arctic/Volcanic) —
  // that's intended demo behaviour per §9.5 biome-locked uniques.

  // T4 power — Fusion Core burns helium_3 as fuel; W contribution lives on
  // def.power.produces (5000W), not in `outputs`. Empty outputs intentional.
  fusion_core: {
    cycleSec: 30,
    inputs: { helium_3: 1 },
    outputs: {},
    category: 'power',
  },

  // T4 biome-locked smelting — Volcanic-only Pyroforge produces Exotic Alloy
  // from Steel + Helium-3 fuel. Per §9.5, only producer of Exotic Alloy in
  // the world. §5.2 heat-source adjacency deferred.
  pyroforge: {
    cycleSec: 60,
    inputs: { steel: 5, helium_3: 1 },
    outputs: { exotic_alloy: 1 },
    category: 'smelting',
  },

  // T4 biome-locked electronics — Arctic-only Cryogenic Compute Center
  // produces AI Cores from Steel + Quantum Chip. Per §9.5, only producer of
  // AI Cores in the world. Arctic ambient cold halves compute-recipe power
  // draw (deferred — modelled at static 1200W in step 12).
  cryogenic_compute_center: {
    cycleSec: 90,
    inputs: { steel: 3, quantum_chip: 1 },
    outputs: { ai_core: 1 },
    category: 'electronics',
  },

  // T4 electronics — Particle Accelerator produces Quantum Chips from
  // Steel + Pig Iron. Not biome-locked (only Carbon Forge / Pyroforge /
  // Cryogenic Compute Center / Mass Driver / Tidal Array / Sunspire are).
  // Tagged `electronics` because Quantum Chip is the T4 electronics
  // intermediate; the building's name is metallurgy-coded but its output
  // is an electronics component.
  particle_accelerator: {
    cycleSec: 45,
    inputs: { steel: 4, pig_iron: 4 },
    outputs: { quantum_chip: 1 },
    category: 'electronics',
  },

  // ---------------------------------------------------------------------------
  // T5 Transcendent chain (§6.6 / §7.12 / §8.10 / step 13)
  // ---------------------------------------------------------------------------
  // Two recipes ship in step 13 to demonstrate the chain end-to-end:
  //   casimir_tap     → 1 casimir_energy / 1800s (no inputs; §8.10 "free vacuum energy")
  //   reality_forge   → 1 reality_anchor / 600s from 2 exotic_alloy + 1 ai_core + 1 casimir_energy
  // The §7.12 spec recipe ("4 ai_core + 1 antimatter_capsule + 1 time_crystal + 1 exotic_alloy
  // + 24h cycle → Reality Anchor") is the full T5 chain; the step-13 placeholder skips
  // antimatter_capsule + time_crystal (not yet in catalog) and condenses cycle time to 600s
  // so the demo chain is exercisable without a 24-hour wait. Full §7.12 recipe deferred
  // to step 14 alongside the missing T4 raws.

  // T5 raw extraction — placeholder for the §8.10 Casimir Tap. Spec cycle
  // 30 min to 4 h; we use the 30 min lower bound. No inputs (free vacuum
  // energy per §8.5 / §8.10). The bulk-power contribution is on
  // def.power.produces (8000W); this recipe is the discrete-unit emission.
  casimir_tap: {
    cycleSec: 1800,
    inputs: {},
    outputs: { casimir_energy: 1 },
    category: 'power',
  },

  // T5 manufacturing — Reality Forge condenses T4 endgame components +
  // T5 raw into a T5 component. Cycle 600s (10 min) placeholder; full
  // §7.12 24h cycle deferred until antimatter_capsule + time_crystal land.
  reality_forge: {
    cycleSec: 600,
    inputs: { exotic_alloy: 2, ai_core: 1, casimir_energy: 1 },
    outputs: { reality_anchor: 1 },
    category: 'manufacturing',
  },
};

/**
 * Tile-dependent recipe resolution per §8.1.
 *
 * Most buildings have a single recipe keyed by `def.id` — the lookup is just
 * `RECIPES[def.id]`. Mine is the §8.1 exception: it produces ore OR coal
 * depending on the tile under its footprint. To keep `PlacedBuilding` pure
 * data (no per-instance recipe state), the variant is resolved at rate-
 * computation time from the terrain function on the IslandSpec.
 *
 * Pure function — no DOM, no PixiJS, no allocation per call beyond the same
 * Recipe-object reference returned from the static RECIPES table. The hot
 * path (computeRates) calls this once per building per pass, so we avoid
 * building intermediate arrays unless we're actually scanning Mine tiles.
 *
 * The `terrainAt` closure is optional. When undefined (legacy callers,
 * tests that don't model terrain), we fall back to `RECIPES[def.id]` — for
 * Mine this is the pre-tile-aware recipe that produces iron_ore, matching
 * historical behaviour.
 *
 * The footprint enumeration mirrors `footprintTiles` in placement.ts but is
 * inlined here to keep `recipes.ts → placement.ts` from forming a runtime
 * import cycle (placement.ts imports `recipes.ts` for ResourceId/
 * ALL_RESOURCES). If we ever pull `footprintTiles` into a primitive module
 * the inlining can be removed.
 */
export function resolveRecipe(
  def: BuildingDef,
  b: PlacedBuilding,
  terrainAt?: (x: number, y: number) => TerrainKind,
): Recipe | undefined {
  if (def.id === 'mine' && terrainAt) {
    let sawCoal = false;
    let sawOre = false;
    const rotation = (b.rotation ?? 0) as Rotation01ish;
    // Inline footprint enumeration — matches the four-rotation transforms
    // in placement.ts `footprintTiles`. Short-circuits on first `coal` tile
    // to keep the typical-case cost minimal.
    for (let dy = 0; dy < def.height; dy++) {
      for (let dx = 0; dx < def.width; dx++) {
        let rx: number;
        let ry: number;
        switch (rotation) {
          case 0: rx = dx; ry = dy; break;
          case 1: rx = def.height - 1 - dy; ry = dx; break;
          case 2: rx = def.width - 1 - dx; ry = def.height - 1 - dy; break;
          case 3: rx = dy; ry = def.width - 1 - dx; break;
        }
        const k = terrainAt(b.x + rx, b.y + ry);
        if (k === 'coal') {
          sawCoal = true;
        } else if (k === 'ore') {
          sawOre = true;
        }
        // We can short-circuit only when we've seen coal: coal wins the
        // tie per the §8.1 "Ore or coal output by tile" rule encoded as
        // "any coal tile → coal recipe". Without seeing coal, an early ore
        // tile may still be followed by coal later in the scan.
        if (sawCoal) {
          return RECIPES.mine_on_coal;
        }
      }
    }
    if (sawOre) return RECIPES.mine_on_ore;
    // No ore and no coal in footprint — shouldn't happen because
    // `validatePlacement` enforces `def.requiredTile` on every footprint
    // tile. Return undefined defensively so the rate loop sees a no-op
    // building rather than picking up a stale (legacy) iron_ore recipe.
    return undefined;
  }
  return RECIPES[def.id as RecipeId];
}

/** Local copy of the rotation union from placement.ts. Kept here to avoid
 *  importing placement.ts (which already imports recipes.ts); the value is
 *  PlacedBuilding.rotation, which placement.ts also constrains to 0|1|2|3. */
type Rotation01ish = 0 | 1 | 2 | 3;
