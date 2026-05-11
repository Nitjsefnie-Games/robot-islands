// Pure-data building catalog per SPEC §8 and §15.1.
//
// `BuildingDef` is the static per-kind definition (footprint, render style,
// recipe binding, power, tier requirement). `PlacedBuilding` (in
// `buildings.ts`) is the per-instance runtime carrying only id/defId/x/y.
// The split lets the same def back many instances without each instance
// repeating fill/stroke/footprint.
//
// Step-9 catalog: T1 + T2 + T3 buildings sufficient to demonstrate the
// Iron/Steel chain (§7.1) end-to-end.
// Step-12 catalog: adds 5 T4 endgame defs (§6.5/§9.5) — Fusion Core,
// Pyroforge (Volcanic-unique), Cryogenic Compute Center (Arctic-unique),
// Particle Accelerator, Launch Tower. Pyroforge + Cryogenic Compute Center
// carry `requiredBiomes` per §15.1; the `canPlaceOnIsland` helper at the
// bottom of this file is the canonical gate.
// Step-13 catalog: adds 7 T5 Transcendent defs (§13.2 / §8.4 / §8.5 / §8.9) —
// Casimir Tap, Reality Forge, Singularity Battery, Time Lock, Genesis Chamber,
// Universe Editor, Lattice Node. Data-only: §13.3 mechanics (time banking,
// free creation, biome reassignment, network unity, etc.) are explicitly
// DEFERRED to step 14+ with a comment at each def site. The T5 access gate
// (§13.1) — level ≥ 50 AND `aiCoreCrafted` flag — is enforced in
// `buildingUnlocked` below, not by the tier-only `tierForLevel`. The Casimir
// Tap power figure is a placeholder; full §8.10 T5 raw extractors (Aetheric
// Conduit, Spacetime Resonator, Eldritch Sieve) and their multi-hour cycle
// times are deferred.
//
// §13.2 deliberate substitution: spec §13.2 lists Probability Engine in the
// T5 building set, but step 13 ships Time Lock instead. Time Lock has richer
// §13.3 behavioural detail (banking + spending semantics) which makes its
// placeholder more meaningful as documentation; Probability Engine's drone
// rare-encounter bias is conceptually simpler and slots in cleanly later.
// Probability Engine is reserved for step 14+.
//
// Heat-source adjacency (§5.2) is not yet implemented — Blast Furnace and
// Pyroforge run without their required heat source; comment flags the
// deferred constraint. T4 omnidirectional pulse mechanic (§11.5) for the
// Launch Tower is also deferred — only the def is added in step 12.
//
// No PixiJS imports, no DOM — `building-defs.ts` is pure data + the tier
// gate + biome gate. `buildings.ts` consumes BUILDING_DEFS for rendering;
// `recipes.ts` keys its RECIPES table by `BuildingDefId`.

import type { TerrainKind } from './island.js';
import { tierForLevel } from './skilltree.js';
// Type-only imports avoid a runtime cycle with world.ts (which imports
// BUILDING_DEFS from this file). The Biome union and IslandSpec interface
// are pure types — `import type` strips the edge at compile time.
import type { Biome, IslandSpec } from './world.js';

/** SPEC §8 building category. Drives the per-category Specialization passive
 *  buff (§9.4) and the Building Catalog UI grouping. */
export type BuildingCategory =
  | 'extraction'
  | 'smelting'
  | 'chemistry'
  | 'manufacturing'
  | 'electronics'
  | 'power'
  | 'storage'
  | 'logistics'
  | 'cooling'
  | 'special';

/** Every defId in the step-9 catalog. New defs require both a literal here
 *  and an entry in BUILDING_DEFS — the indexed access in renderBuildings/
 *  economy would silently break on an undefined lookup otherwise. */
export type BuildingDefId =
  // Existing (step 1-8): T1 buildings on the home island
  | 'mine'
  | 'workshop'
  | 'solar'
  | 'coal_gen'
  | 'dock'
  | 'dronepad'
  // New T1
  | 'logger'
  | 'smelter'
  | 'crate'
  | 'silo'
  | 'biomass_plant'
  // T1 manufacturing — Foundation Kit Assembler (§12.3 / §12 settlement)
  | 'kit_assembler'
  // T1 logistics — Shipyard for §12 ship dispatch
  | 'shipyard'
  // T2 logistics — Helipad for §12 helicopter dispatch
  | 'helipad'
  // New T2
  | 'coke_oven'
  | 'blast_furnace'
  | 'steel_mill'
  | 'assembler'
  | 'tank'
  // New T3
  | 'electric_arc_furnace'
  | 'platform_constructor'
  // New T4 (§6.5 / §9.5 / step 12)
  | 'fusion_core'
  | 'pyroforge'
  | 'cryogenic_compute_center'
  | 'particle_accelerator'
  | 'launch_tower'
  // New T5 (§13.2 / §8.4 / §8.5 / §8.9 / step 13)
  | 'casimir_tap'
  | 'reality_forge'
  | 'singularity_battery'
  | 'time_lock'
  | 'genesis_chamber'
  | 'universe_editor'
  | 'lattice_node';

/**
 * Per-kind static definition. Step 9 fills the fields needed by the
 * economy + render layer; `requiredTile`, adjacency, and the heat flag stay
 * in SPEC §15.1's BuildingDef shape but are not used yet.
 *
 * Step 12 wires `requiredBiomes` per §15.1 / §9.5: a non-empty list means
 * the building can only be placed on an island whose biome is in the set
 * (and never on artificial islands). The canonical gate is
 * `canPlaceOnIsland` at the bottom of this file.
 */
export interface BuildingDef {
  readonly id: BuildingDefId;
  readonly displayName: string;
  readonly category: BuildingCategory;
  readonly tier: 1 | 2 | 3 | 4 | 5 | 6;
  /** Footprint width in tiles (whole tiles only). */
  readonly width: number;
  /** Footprint height in tiles. */
  readonly height: number;
  /** Primary fill colour (PIXI hex). */
  readonly fill: number;
  /** Stroke / outline colour. */
  readonly stroke: number;
  /** Optional storage cap contribution. Per §8.4 spec, Silo is dry-goods-only
   *  and Tank liquids/gases-only; for step 9 we simplify and aggregate
   *  `storageCap` as a uniform "+N to ALL resources" on placement. The
   *  category-routed-storage system is deferred. */
  readonly storageCap?: number;
  /** §5.1 electrical contribution. Either side may be undefined / 0. */
  readonly power?: { readonly produces?: number; readonly consumes?: number };
  /** §15.1 / §9.5 biome restriction for biome-locked uniques (T4). Undefined
   *  means "any biome". A non-empty list restricts placement to natural
   *  islands of the listed biomes — `canPlaceOnIsland` enforces the gate. */
  readonly requiredBiomes?: ReadonlyArray<Biome>;
  /** §4.3 / §8.1 terrain-tile requirement. If present and non-empty, EVERY
   *  tile in the building's footprint must have a TerrainKind in this set,
   *  per §4.3 ("Mine requires every cell of its footprint to be on an
   *  ore/coal vein"). Undefined / empty = no tile requirement (any in-island
   *  tile accepted). `validatePlacement` in placement.ts is the canonical
   *  gate. Currently honored by: `mine` (ore or coal). Other §8.1 entries
   *  (Logger → tree, Quarry → stone, Well → water) are documented in their
   *  def comments with `requiredTile` unset until those buildings ship. */
  readonly requiredTile?: ReadonlyArray<TerrainKind>;
}

/** Read-only catalog. Keys = BuildingDefId; every defId MUST have an entry. */
export const BUILDING_DEFS: Readonly<Record<BuildingDefId, BuildingDef>> = {
  // -------------------------------------------------------------------------
  // T1 (levels 1-5)
  // -------------------------------------------------------------------------
  // §8.1: Mine output branches on the underlying tile — every footprint cell
  // must be on an ore vein OR a coal vein, and the recipe variant produced is
  // selected by tile type via `resolveRecipe` in recipes.ts:
  //   - footprint contains a `coal` tile → produces coal
  //   - else footprint all `ore`         → produces iron_ore
  // Per §8.1 catalog: "Mine | 2x2 | T1 | ore vein or coal vein | … Ore or coal
  // output by tile". `requiredTile` is the placement gate; recipe selection is
  // a runtime resolve so a single defId backs both extraction variants.
  mine: {
    id: 'mine',
    displayName: 'Mine',
    category: 'extraction',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0x9a9a9a,
    stroke: 0x222222,
    power: { consumes: 40 },
    requiredTile: ['ore', 'coal'],
  },
  workshop: {
    id: 'workshop',
    displayName: 'Workshop',
    category: 'manufacturing',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0xe07b3a,
    stroke: 0x6b2f00,
    power: { consumes: 60 },
  },
  solar: {
    id: 'solar',
    displayName: 'Solar Panel',
    category: 'power',
    tier: 1,
    width: 1,
    height: 1,
    fill: 0xf2c84b,
    stroke: 0x6a4a00,
    power: { produces: 50 },
  },
  coal_gen: {
    id: 'coal_gen',
    displayName: 'Coal Generator',
    category: 'power',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0xd97a18,
    stroke: 0x4a2400,
    power: { produces: 100 },
  },
  dock: {
    id: 'dock',
    displayName: 'Cargo Dock',
    category: 'logistics',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0x3a7bd5,
    stroke: 0x0a2a55,
  },
  // §8.8 lists Drone Pad as T2. Step 6 hardcoded it on the home island
  // (T1) so the drone demo works without a level grind; preserved here as
  // T1 with a deferred-tier comment. Re-tier to T2 when placement +
  // settlement (step 2.5 / §12) land and the demo no longer relies on it.
  dronepad: {
    id: 'dronepad',
    displayName: 'Drone Pad',
    category: 'logistics',
    tier: 1, // §8.8 = T2; demo retains T1 until placement system arrives.
    width: 1,
    height: 1,
    fill: 0x4a6b78,
    stroke: 0x14222a,
  },
  logger: {
    id: 'logger',
    displayName: 'Logger',
    category: 'extraction',
    tier: 1,
    width: 1,
    height: 1,
    fill: 0x2f5e2c,
    stroke: 0x0f2a0c,
    // §8.1: requires a `tree` tile. Placement isn't built (step 2.5) so the
    // tile requirement is unenforced for step 9 — Logger placed on forest-ne
    // produces wood without a `tree` adjacency check.
  },
  smelter: {
    id: 'smelter',
    displayName: 'Smelter',
    category: 'smelting',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0x7a5050,
    stroke: 0x3a1a1a,
    power: { consumes: 50 },
  },
  crate: {
    id: 'crate',
    displayName: 'Crate',
    category: 'storage',
    tier: 1,
    width: 1,
    height: 1,
    fill: 0x8a6a3a,
    stroke: 0x402a10,
    // §8.4: spec says +100 cap on one player-CHOSEN resource. For step 9
    // we simplify to +100 to ALL resources (player choice UI = deferred).
    storageCap: 100,
  },
  silo: {
    id: 'silo',
    displayName: 'Silo',
    category: 'storage',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0xa08a5a,
    stroke: 0x504028,
    // §8.4: spec says +2000 cap, dry-goods-only. Categorised routing is
    // deferred for step 9; we apply uniformly to all resources.
    storageCap: 2000,
  },
  biomass_plant: {
    id: 'biomass_plant',
    displayName: 'Biomass Plant',
    category: 'power',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0x3e7a36,
    stroke: 0x1a3a16,
    power: { produces: 80 },
  },
  // §12.3: Foundation Kit Assembler. A T1 manufacturing building dedicated
  // to crafting the Standard Foundation Kit consumed by §12 settlement
  // vehicles. Step-12 simplification: the spec lists Workshop (T1) and
  // Assembler (T2+) as the kit-crafting buildings, but those already own
  // bolt/gear recipes in our 1:1 recipe-per-building model. Introducing a
  // dedicated `kit_assembler` defId keeps the recipe table conflict-free
  // until the engine grows true multi-recipe-per-building selection.
  kit_assembler: {
    id: 'kit_assembler',
    displayName: 'Kit Assembler',
    category: 'manufacturing',
    tier: 1,
    width: 2,
    height: 2,
    fill: 0xb88a5a,
    stroke: 0x4a3520,
    power: { consumes: 70 },
  },
  // §8.8 / §12.2: Shipyard — T1 logistics building that launches §12 cargo
  // ships for settlement (and, later, T1 cargo routes). Spec requires
  // coastal placement; coastal-tile gating is DEFERRED (no water-tile
  // system yet). Step-12 places Shipyard freely on any tile inside the
  // island ellipse.
  shipyard: {
    id: 'shipyard',
    displayName: 'Shipyard',
    category: 'logistics',
    tier: 1,
    width: 3,
    height: 3,
    fill: 0x3a7bd5,
    stroke: 0x0a2a55,
    power: { consumes: 80 },
  },
  // §8.8 / §12.2: Helipad — T2 logistics building that launches §12
  // helicopters for settlement. Faster than ships, no coastal requirement.
  helipad: {
    id: 'helipad',
    displayName: 'Helipad',
    category: 'logistics',
    tier: 2,
    width: 2,
    height: 2,
    fill: 0x6a8a9a,
    stroke: 0x1f3340,
    power: { consumes: 60 },
  },
  // -------------------------------------------------------------------------
  // T2 (levels 5-15)
  // -------------------------------------------------------------------------
  coke_oven: {
    id: 'coke_oven',
    displayName: 'Coke Oven',
    category: 'smelting',
    tier: 2,
    width: 2,
    height: 2,
    fill: 0x6a5a48,
    stroke: 0x2a2014,
    power: { consumes: 60 },
  },
  blast_furnace: {
    id: 'blast_furnace',
    displayName: 'Blast Furnace',
    category: 'smelting',
    tier: 2,
    width: 3,
    height: 3,
    fill: 0x8a2a1a,
    stroke: 0x401005,
    power: { consumes: 100 },
    // §5.2 / §8.2: spec requires an adjacent Heat Source (Coal Furnace,
    // Geothermal Vent, etc.). The heat-adjacency system is not yet built
    // (deferred — heat propagation lands with step 11/12). For step 9 the
    // Blast Furnace runs unconditionally given inputs + power.
  },
  steel_mill: {
    id: 'steel_mill',
    displayName: 'Steel Mill',
    category: 'smelting',
    tier: 2,
    width: 3,
    height: 3,
    fill: 0x6e7480,
    stroke: 0x2a2e36,
    power: { consumes: 120 },
    // §7.1: spec's "Pig iron + Scrap → Steel" includes Scrap as a co-input.
    // Scrap as a substitute/byproduct (§6.7) is deferred. Step 9 recipe is
    // Pig Iron → Steel.
  },
  assembler: {
    id: 'assembler',
    displayName: 'Assembler',
    category: 'manufacturing',
    tier: 2,
    width: 2,
    height: 2,
    fill: 0xff8c2a,
    stroke: 0x6e3500,
    power: { consumes: 80 },
  },
  tank: {
    id: 'tank',
    displayName: 'Tank',
    category: 'storage',
    tier: 2,
    width: 2,
    height: 2,
    fill: 0x2a4078,
    stroke: 0x0a1a3a,
    storageCap: 2000,
    // §8.4: liquids/gases-only. Categorised routing deferred — Tank
    // applies uniformly to all resources for step 9.
  },
  // -------------------------------------------------------------------------
  // T3 (levels 15-30)
  // -------------------------------------------------------------------------
  electric_arc_furnace: {
    id: 'electric_arc_furnace',
    displayName: 'Electric Arc Furnace',
    category: 'smelting',
    tier: 3,
    width: 2,
    height: 3,
    fill: 0x4a8ae0,
    stroke: 0x1a3a78,
    power: { consumes: 200 },
  },
  // §8.9: Platform Constructor (a.k.a. Foundry of Lands). T3 special building
  // — gates artificial-island construction (§2.5). Step 11 only checks for the
  // building's PRESENCE on the founder island; placement/power/heat enforcement
  // is deferred. Power-consumption is declared per §5.1 so a future-step
  // brownout properly throttles construction availability.
  platform_constructor: {
    id: 'platform_constructor',
    displayName: 'Platform Constructor',
    category: 'special',
    tier: 3,
    width: 4,
    height: 4,
    fill: 0x6a4a8c, // dusky violet — "foundry"-coded
    stroke: 0x2a1a40,
    power: { consumes: 200 },
  },
  // -------------------------------------------------------------------------
  // T4 (levels 30-50) — endgame chain per §6.5 / §8.5 / §9.5
  // -------------------------------------------------------------------------
  // §8.5: Fusion Core — universal T4 power source, Helium-3 fuel, massive
  // output (5000W). Not biome-locked. Per §5.2 it also doubles as a free
  // heat source; the heat system is deferred so only the power contribution
  // is wired in step 12.
  fusion_core: {
    id: 'fusion_core',
    displayName: 'Fusion Core',
    category: 'power',
    tier: 4,
    width: 4,
    height: 4,
    fill: 0x4a90c8, // cool electric blue
    stroke: 0x1a3050,
    power: { produces: 5000 },
  },
  // §9.5: Pyroforge — Volcanic-unique. Only producer of Exotic Alloy in the
  // world. §5.2 heat-source adjacency deferred — runs without an adjacent
  // Geothermal Vent for step 12.
  pyroforge: {
    id: 'pyroforge',
    displayName: 'Pyroforge',
    category: 'smelting',
    tier: 4,
    width: 3,
    height: 3,
    fill: 0xc04020, // lava red
    stroke: 0x2a0800,
    power: { consumes: 800 },
    requiredBiomes: ['volcanic'],
  },
  // §9.5: Cryogenic Compute Center — Arctic-unique. Only producer of AI
  // Cores. Arctic ambient cold should halve compute-recipe power draw (§9.5
  // intrinsic bonus); deferred to a later step, modelled at static 1200W
  // here.
  cryogenic_compute_center: {
    id: 'cryogenic_compute_center',
    displayName: 'Cryogenic Compute Center',
    category: 'electronics',
    tier: 4,
    width: 4,
    height: 4,
    fill: 0xa0e0e8, // icy cyan
    stroke: 0x205060,
    power: { consumes: 1200 },
    requiredBiomes: ['arctic'],
  },
  // §8.6: Particle Accelerator — T4 production of Quantum Chips (and, in
  // a later step, Antimatter Capsule via a separate recipe per §7.11). Not
  // biome-locked; the §9.5 list reserves "biome-locked" for the bottleneck
  // outputs (Exotic Alloy, AI Core, Carbon Fiber, etc.).
  particle_accelerator: {
    id: 'particle_accelerator',
    displayName: 'Particle Accelerator',
    category: 'smelting',
    tier: 4,
    width: 4,
    height: 4,
    fill: 0x8060c0, // deep violet
    stroke: 0x301050,
    power: { consumes: 1500 },
  },
  // §8.8 / §11.5: Launch Tower — T4 omnidirectional drone-pulse launch
  // site. The pulse mechanic itself (3-cell-radius single-disk reveal) is
  // deferred; the def exists in step 12 so the catalog row + tier badge
  // are visible.
  launch_tower: {
    id: 'launch_tower',
    displayName: 'Launch Tower',
    category: 'special',
    tier: 4,
    width: 3,
    height: 3,
    fill: 0x8a8a40, // dull sand-gold
    stroke: 0x303010,
    power: { consumes: 400 },
  },
  // -------------------------------------------------------------------------
  // T5 (levels 50+, AI Core required) — Transcendent per §13 / step 13
  // -------------------------------------------------------------------------
  // §8.5 / §8.10: Casimir Tap — T5 power source AND raw extractor for
  // Casimir energy / Zero-point flux. Step-13 simplification: declared as a
  // power producer (8000W placeholder; §8.5 says "free vacuum energy") with
  // a slow recipe emitting `casimir_energy`. Full §8.10 dual-output cycle
  // (Casimir energy OR Zero-point flux per cycle) plus the §8.10 30-minute
  // cycle time stay deferred — step-13 recipe uses 1800s (30 min) for the
  // placeholder, consistent with the §8.10 lower-bound dwell.
  casimir_tap: {
    id: 'casimir_tap',
    displayName: 'Casimir Tap',
    category: 'power',
    tier: 5,
    width: 2,
    height: 2,
    fill: 0x3a0a4a, // deep void violet
    stroke: 0x100020,
    power: { produces: 8000 },
  },
  // §8.3: Reality Forge — T5 manufacturing. Consumes T4 components +
  // Casimir energy to produce Reality Anchor (a T5 component per §6.6).
  // This is the demonstrative T5 chain: T4 Exotic Alloy + AI Core +
  // T5 Casimir energy → Reality Anchor.
  reality_forge: {
    id: 'reality_forge',
    displayName: 'Reality Forge',
    category: 'manufacturing',
    tier: 5,
    width: 4,
    height: 4,
    fill: 0x6020a0, // amethyst violet
    stroke: 0x100040,
    power: { consumes: 3000 },
  },
  // §8.4: Singularity Battery — "effectively infinite electrical power
  // storage" per spec. Categorised here as `power` per the task brief: the
  // §5.1 model has no power-buffer concept yet, so the step-13 def carries a
  // generic `storageCap` of 10000 (Crate/Silo-style uniform resource cap) as
  // a stand-in until power buffering arrives. Tiny consumption (100W) models
  // continuous overhead. Power-storage mechanic per §13.3 DEFERRED to step 14+.
  singularity_battery: {
    id: 'singularity_battery',
    displayName: 'Singularity Battery',
    category: 'power',
    tier: 5,
    width: 2,
    height: 2,
    fill: 0x202060, // deep ultramarine
    stroke: 0x0a0a30,
    power: { consumes: 100 },
    storageCap: 10000,
  },
  // §8.9 / §13.3: Time Lock — banks offline-time stockpile per island and
  // spends to accelerate any chosen island's tick rate at 3×. Time-banking
  // mechanics per §13.3 DEFERRED to step 14: in step 13 the def ships as a
  // visible catalog row + power-consuming placeholder. No recipe (the
  // banking/spending model isn't an inputs→outputs recipe).
  time_lock: {
    id: 'time_lock',
    displayName: 'Time Lock',
    category: 'special',
    tier: 5,
    width: 3,
    height: 3,
    fill: 0xc080e0, // pale aurora violet
    stroke: 0x400060,
    power: { consumes: 1500 },
  },
  // §8.9 / §13.3: Genesis Chamber — free-creation of T1-T4 resources from
  // electrical power alone (placeholder cycle 5 min, tier-scaling power
  // draw). Free-creation mechanic per §13.3 DEFERRED to step 14; def ships
  // as a visible catalog row + power-consuming placeholder. No recipe (the
  // player-target-resource selection isn't a fixed inputs→outputs recipe).
  genesis_chamber: {
    id: 'genesis_chamber',
    displayName: 'Genesis Chamber',
    category: 'special',
    tier: 5,
    width: 4,
    height: 4,
    fill: 0xa0e0a0, // ethereal green
    stroke: 0x205020,
    power: { consumes: 2500 },
  },
  // §8.9 / §13.3: Universe Editor — reassigns an island's biome and
  // regenerates terrain. Biome reassignment per §13.3 DEFERRED to step 14;
  // def ships as a visible catalog row + power-consuming placeholder. No
  // recipe (the biome-rewrite invocation isn't a continuous production
  // cycle).
  universe_editor: {
    id: 'universe_editor',
    displayName: 'Universe Editor',
    category: 'special',
    tier: 5,
    width: 3,
    height: 3,
    fill: 0xff80a0, // rose-pink
    stroke: 0x500020,
    power: { consumes: 4000 },
  },
  // §8.9 / §13.3: Lattice Node — one per networked T5 island; activates
  // Omniscient Lattice (unified inventory + cross-island adjacency) when
  // N nodes are placed across N T5-mastered islands. Network unity per
  // §13.3 (Omniscient Lattice) DEFERRED to step 14; def ships as an inert
  // placeholder with a small standby power draw. No recipe.
  lattice_node: {
    id: 'lattice_node',
    displayName: 'Lattice Node',
    category: 'special',
    tier: 5,
    width: 2,
    height: 2,
    fill: 0x80f0c0, // mint-cyan
    stroke: 0x205040,
    power: { consumes: 800 },
  },
};

/** Whether `defId` is buildable at the given island level. Pure — no DOM,
 *  no PixiJS. Consumers: Building Catalog UI (locks rows above current
 *  tier) and (future, step 2.5) placement validator.
 *
 *  Step-13: T5 defs require an additional `aiCoreCrafted` gate per §13.1
 *  ("Island reaches level 50 AND has crafted at least one AI core"). The
 *  parameter defaults to `false` so existing callers (and the unlockedDefs
 *  helper) keep working without modification — T5 rows stay locked unless
 *  the caller explicitly opts in by passing `state.aiCoreCrafted`. */
export function buildingUnlocked(
  islandLevel: number,
  defId: BuildingDefId,
  aiCoreCrafted: boolean = false,
): boolean {
  const def = BUILDING_DEFS[defId];
  if (def.tier === 5) return islandLevel >= 50 && aiCoreCrafted;
  return tierForLevel(islandLevel) >= def.tier;
}

/** Every def unlocked at the given island level, in catalog declaration order.
 *  Step-13: T5 defs are EXCLUDED from this list unless `aiCoreCrafted` is
 *  also true (defaults to false to keep tier-only callers unaffected). */
export function unlockedDefs(
  islandLevel: number,
  aiCoreCrafted: boolean = false,
): BuildingDefId[] {
  return (Object.keys(BUILDING_DEFS) as BuildingDefId[]).filter((id) =>
    buildingUnlocked(islandLevel, id, aiCoreCrafted),
  );
}

/** Convenience: every defId in declaration order. Pure data — useful for the
 *  Catalog UI which groups by tier. */
export const ALL_BUILDING_DEF_IDS: ReadonlyArray<BuildingDefId> = Object.keys(
  BUILDING_DEFS,
) as BuildingDefId[];

/**
 * Per §15.1 / §9.5: can the given def be placed on the given island?
 *
 * Two gates compose:
 *   - `requiredBiomes` (if set) must include the island's biome.
 *   - artificial islands (spec.artificial === true) cannot host any def
 *     that has a `requiredBiomes` restriction — per §9.5 "Artificial
 *     islands cannot host biome-locked uniques."
 *
 * Pure function — no DOM, no PixiJS, no IslandState dependency. Tier-gate
 * (`buildingUnlocked`) is intentionally separate; placement validators
 * typically check both `buildingUnlocked(state.level, defId)` AND
 * `canPlaceOnIsland(def, spec)`.
 */
export function canPlaceOnIsland(def: BuildingDef, spec: IslandSpec): boolean {
  if (def.requiredBiomes) {
    if (!def.requiredBiomes.includes(spec.biome)) return false;
    if (spec.artificial) return false;
  }
  return true;
}
