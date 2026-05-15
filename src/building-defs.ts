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
// Heat-source adjacency (§5.2) IS implemented. The economy passes consumer
// recipes through `resolveHeatAssignments` (heat.ts) before rate computation:
// a `requiresHeat` building with no adjacent Heat Source has its effective
// rate forced to 0 and contributes 0 to P_consumed. Coal-burning sources
// (Coal Furnace) burn `coalPerCycle × consumersServed` coal per cycle; free
// sources (Geothermal Vent / Plasma Heater / Fusion Core) cost no fuel.
// T4 omnidirectional pulse mechanic (§11.5) for the Launch Tower remains
// deferred — only the def is added in step 12.
//
// No PixiJS imports, no DOM — `building-defs.ts` is pure data + the tier
// gate + biome gate. `buildings.ts` consumes BUILDING_DEFS for rendering;
// `recipes.ts` keys its RECIPES table by `BuildingDefId`.

import type { TerrainKind } from './island.js';
import type { ResourceId } from './recipes.js';
import { SHAPES, type ShapeMask } from './shape-mask.js';
import { tierForLevel } from './skilltree.js';
import type { StorageCategory } from './storage-categories.js';
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
  // T3 logistics — Patron Hub for §9.6 Auto-Patronage
  | 'patron_hub'
  // New T2
  | 'coke_oven'
  | 'blast_furnace'
  | 'steel_mill'
  | 'oxygen_converter'
  | 'slag_reprocessor'
  | 'assembler'
  | 'fabricator'
  | 'precision_lab'
  | 'singularity_forge'
  | 'tank'
  | 'cold_storage'
  | 'component_warehouse'
  // §3.4 / §8.9: Land Reclamation Hub — T2 trigger building. Placing it
  // enables the inspector's "expand ellipse" action; the building has no
  // recipe and consumes no power continuously.
  | 'land_reclamation_hub'
  // New T3
  | 'electric_arc_furnace'
  | 'vault'
  | 'platform_constructor'
  // New T4 (§6.5 / §9.5 / step 12)
  | 'fusion_core'
  | 'pyroforge'
  | 'cryogenic_compute_center'
  | 'particle_accelerator'
  | 'launch_tower'
  // §9.5 biome-locked uniques (Mass Driver + Carbon Forge + Tidal Array + Sunspire)
  | 'mass_driver'
  | 'carbon_forge'
  | 'tidal_array'
  | 'sunspire'
  // New T5 (§13.2 / §8.4 / §8.5 / §8.9 / step 13)
  | 'casimir_tap'
  | 'reality_forge'
  | 'singularity_battery'
  | 'time_lock'
  | 'genesis_chamber'
  | 'universe_editor'
  | 'lattice_node'
  // §11.6 T5 path-drawn drone launcher + §13.3 Probability Engine
  | 'path_drone_foundry'
  | 'probability_engine'
  // T5→T6 transition (step 20): produces `ascendant_core`, the §14.1 gate
  // artifact. Built at T5 (level 50 + AI core) so the player can craft
  // ascendant_core BEFORE the §14.1 Spaceport requirement — Ascendant
  // Core is per §13.4 a T5 endgame artifact whose existence promotes the
  // island into the T6 access band.
  | 'ascendant_assembly'
  // New T6 (§14 / step 20) — data-only. §14.2-14.8 / §14.12 live mechanics
  // (satellite launches, debris fields, comm graph, repair drones,
  // lodge events) are DEFERRED; these defs ship as visible catalog rows
  // plus power-balance contributions. §14.2 Spaceport tier I/II/III
  // upgrade lifecycle, §14.3 satellite variants, §14.4 comm graph,
  // §14.5 dwell ramps, §14.6 maneuvering fuel, §14.7 launch success,
  // §14.8 debris and Kessler cascades, §14.9 four new Orbital skill
  // sub-paths, §14.12 Repair Drone operations — all deferred.
  | 'spaceport'
  | 'orbital_tracking_station'
  | 'antimatter_refinery'
  | 'scanner_sat_assembly'
  | 'comm_sat_assembly'
  | 'orbital_insertion_assembly'
  | 'sweeper_sat_assembly'
  | 'repair_pack_assembly'
  // Step-18 recipe-graph closure (§7.1-§7.12). One defId per recipe
  // since the engine's 1:1 recipe-per-defId model doesn't support
  // multi-recipe-per-building selection without infra changes.
  | 'quarry'
  | 'sand_pit'
  | 'well'
  // §8.1 T2 extraction
  | 'heavy_logger'
  | 'deep_mine'
  | 'coastal_pump'
  | 'quartz_mine'
  | 'limestone_quarry'
  | 'clay_pit_extractor'
  | 'sulfur_mine'
  | 'phosphate_mine'
  | 'graphite_mine'
  | 'lumber_mill'
  | 'glassworks'
  | 'evaporator'
  | 'electrolyzer'
  | 'biofuel_plant'
  | 'pump_jack'
  | 'gas_extractor'
  | 'naphtha_cracker'
  | 'chlor_alkali_plant'
  | 'chemical_reactor'
  | 'lubricant_refinery'
  | 'diesel_refinery'
  | 'metal_rolling_mill'
  | 'silicon_crusher'
  | 'air_separator'
  | 'cryo_lab'
  | 'cryo_compressor'
  | 'kerosene_refinery'
  | 'lithography_lab'
  | 'drilling_rig'
  | 'aetheric_conduit'
  | 'spacetime_resonator'
  | 'eldritch_sieve'
  | 'plasma_forge'
  | 'eldritch_refiner'
  | 'phase_refiner'
  // §5.2 / §8.6 Heat Sources. The economy reads `def.heatSource` to identify
  // sources during heat-adjacency resolution. Each free source costs no fuel
  // when serving consumers; coal_furnace burns `coalPerCycle × consumers` per
  // cycle. (Fusion Core also acts as a free heat source — its `heatSource`
  // flag is set on the existing T4 power def below.)
  | 'coal_furnace'
  | 'geothermal_vent'
  | 'plasma_heater'
  // Vision-extending Lighthouse buildings (§15.x — Lighthouse vision). Six
  // tiers spanning T1-T6; vision radius (in tiles) lives in
  // `lighthouse.ts → LIGHTHOUSE_VISION_RADII`. T1 is zero-power (cheap
  // signal beacon); T2+ consumes power so each tier has an upkeep.
  | 'lighthouse_t1'
  | 'lighthouse_t2'
  | 'lighthouse_t3'
  | 'lighthouse_t4'
  | 'lighthouse_t5'
  | 'lighthouse_t6'
  // §11 telemetry redesign: Antennas are the signal-relay infrastructure for
  // drone scan data. A drone outside any antenna's signal range throws away
  // its scan results — see `antenna.ts → ANTENNA_SIGNAL_RADII` for radii.
  // T1-T3 are 1×1; T4-T6 are 2×2 "comm towers". T1 is zero-power (basic
  // beacon); T2+ consumes power proportional to tier. T6 doubles as a
  // satellite dish for the §14 orbital launch chain (dish dual-role
  // DEFERRED). Costs are placeholders — Antenna placeholder — tune in
  // Appendix A.
  | 'antenna_t1'
  | 'antenna_t2'
  | 'antenna_t3'
  | 'antenna_t4'
  | 'antenna_t5'
  | 'antenna_t6'
  | 'pcb_etcher'
  | 'circuit_assembler'
  | 'processor_fab'
  | 'compute_module_fab'
  // §2.6 weather stations
  | 'weather_station_t2'
  | 'advanced_weather_station_t3'
  // §8.5 power generation
  | 'wind_turbine'
  | 'cryogenic_generator'
  | 'nuclear_reactor'
  // §8.7 cooling / treatment
  | 'cooling_tower'
  | 'wastewater_treatment'
  | 'exhaust_scrubber'
  | 'airship_dock'
  | 'teleporter_pad'
  | 'spacetime_anchor'
  | 'power_substation'
  | 'terrain_modifier';

/**
 * §4.5 buff-adjacency entry: per matching 4-neighbor, multiply the building's
 * recipe rate by `1 + percentPerMatch / 100`, summed additively up to
 * `maxMatches` matches. Multiple AdjacencyBuff entries on the same def stack
 * MULTIPLICATIVELY (e.g. two entries each yielding ×1.20 → final ×1.44).
 *
 * `matchKind` selects what counts as a "matching" neighbor:
 *   - `'same_def'` — neighbor's `defId === this.defId` (clustering bonus).
 *   - `'same_category'` — neighbor's def category === this def's category.
 *   - `'def_id'` — neighbor's `defId === matchDefId` (cross-def synergy).
 *     `matchDefId` is REQUIRED when `matchKind === 'def_id'`.
 *
 * Resolution lives in `adjacency.ts` (`computeBuffStack`); the economy
 * applies the returned multiplier to the building's recipe `baseRate` in
 * both passes of `computeRates`. Per spec §4.4 the adjacency relation is
 * 4-neighbor over the footprint border, with a multi-tile neighbor sharing
 * multiple border tiles counted as a single match.
 */
export interface AdjacencyBuff {
  readonly matchKind: 'same_def' | 'same_category' | 'def_id';
  /** Required when `matchKind === 'def_id'`; ignored otherwise. */
  readonly matchDefId?: BuildingDefId;
  /** Per-match additive percentage (e.g. 10 → +10%/match). */
  readonly percentPerMatch: number;
  /** Cap on the number of matches counted. */
  readonly maxMatches: number;
}

/** §4.5 gating adjacency match type. Hard gates zero output entirely;
 *  soft gates degrade by `degradeMul`. */
export type GateMatchType = 'same_def' | 'same_category' | 'def_id' | 'heat_source';

/** §4.5 gating adjacency requirement. A building declares zero or more
 *  gates; each must be satisfied for full-rate operation. */
export interface GateRequirement {
  readonly matchType: GateMatchType;
  /** Specific defId when matchType === 'def_id'. */
  readonly defId?: BuildingDefId;
  /** Specific category when matchType === 'same_category'. */
  readonly category?: BuildingCategory;
  /** Minimum number of adjacent matches required (default 1). */
  readonly minCount?: number;
  /** If true, missing gate zeros output entirely. If false, degrades. */
  readonly hard?: boolean;
  /** Degraded output multiplier when soft-gate is unmet (default 0.5). */
  readonly degradeMul?: number;
}

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
  /** Footprint shape mask — the set of tile offsets covered by this building. */
  readonly footprint: ShapeMask;
  /** Primary fill colour (PIXI hex). */
  readonly fill: number;
  /** Stroke / outline colour. */
  readonly stroke: number;
  /** §4.6 storage contribution. Specialized buildings (Silo dry-goods, Tank
   *  liquids/gases, Cold Storage temp-sensitive, Component Warehouse
   *  components, Vault rare) declare a non-`generic` category; their capacity
   *  applies to every ResourceId whose `RESOURCE_STORAGE_CATEGORY` matches.
   *  Generic buildings (Crate, Warehouse) use `category: 'generic'` and bump
   *  capacity only for the single resource named on each PlacedBuilding's
   *  `cargoLabel`. Undefined = the def doesn't contribute storage at all. */
  readonly storage?: {
    readonly category: StorageCategory | 'generic';
    readonly capacity: number;
  };
  /** §5.1 electrical contribution. Either side may be undefined / 0.
   *  `solar: true` marks the producer as sun-driven — its `produces`
   *  output is multiplied by the §2.7 day-night `solarMultiplier` at
   *  the current world tick (Day 1.0, Dawn/Dusk 0.5, Night 0.0). Only
   *  applies to the production side; consumers ignore the flag. */
  readonly power?: {
    readonly produces?: number;
    readonly consumes?: number;
    readonly solar?: boolean;
  };
  /** §15.1 / §9.5 biome restriction for biome-locked uniques (T4). Undefined
   *  means "any biome". A non-empty list restricts placement to natural
   *  islands of the listed biomes — `canPlaceOnIsland` enforces the gate. */
  readonly requiredBiomes?: ReadonlyArray<Biome>;
  /** §4.3 / §8.1 terrain-tile requirement. If present and non-empty, EVERY
   *  tile in the building's footprint must have a TerrainKind in this set,
   *  per §4.3 ("Mine requires every cell of its footprint to be on an
   *  ore/coal vein"). Undefined / empty = no tile requirement (any in-island
   *  tile accepted). `validatePlacement` in placement.ts is the canonical
   *  gate. Honored by all extractors (mine, logger, quarry, sand_pit, well,
   *  coastal_pump, quartz_mine, pump_jack, gas_extractor, drilling_rig). */
  readonly requiredTile?: ReadonlyArray<TerrainKind>;
  /** §8.8 coastal placement: at least one footprint tile must be water.
   *  Distinct from `requiredTile` which requires ALL tiles to match. */
  readonly coastal?: boolean;
  /** Visual polish: a 1-2 character glyph stamped centred on the building
   *  footprint at render time (see `renderBuildings`). Chosen from the
   *  monospace-friendly Unicode block so the schematic reads at a glance
   *  without a sprite pipeline (mine = ⛏, smelter = △, solar = ☀, etc.).
   *  Every def MUST declare a glyph — the catalog completeness test in
   *  `building-defs.test.ts` enforces this. */
  readonly glyph: string;
  /** §5.2 / §8.6 Heat Source declaration. Presence makes the building a
   *  Heat Source for the adjacency resolver (`heat.ts`).
   *    - `freeOrCoal: 'free'` — Geothermal Vent, Plasma Heater, Fusion Core.
   *      Costs no fuel; can serve any number of adjacent consumers.
   *    - `freeOrCoal: 'coal'` — Coal Furnace. Burns `coalPerCycle × consumers`
   *      coal per 30s cycle. `coalPerCycle` is the per-consumer fuel cost
   *      (base 1 in the only current coal source).
   *  When undefined, the building is not a heat source. */
  readonly heatSource?: {
    readonly freeOrCoal: 'free' | 'coal';
    readonly coalPerCycle?: number;
  };
  /** §5.2 heat-consumer declaration. When `true`, the building requires at
   *  least one adjacent Heat Source in its 4-neighbor footprint border to
   *  operate. Without heat, the economy zeroes its effective rate and skips
   *  its power-consumption contribution (§5.1 inactive). Currently set on
   *  Coke Oven, Blast Furnace, Electric Arc Furnace, and Pyroforge. NOT
   *  set on the T1 Smelter — the basic smelter remains the bootstrap
   *  unconditional iron→ingot link (a Smelter without heat is intentional). */
  readonly requiresHeat?: boolean;
  /** §4.5 buff-adjacency entries. Each entry contributes additively up to
   *  its `maxMatches` cap; entries compose multiplicatively. Undefined or
   *  empty = no adjacency buff (default). Resolution: `computeBuffStack`
   *  in `adjacency.ts`, called from `computeRates`. */
  readonly adjacencyBuffs?: ReadonlyArray<AdjacencyBuff>;
  /** §4.5 gating adjacency requirements. Hard gates zero output; soft gates
   *  degrade by `degradeMul`. Resolution: `checkGates` in `adjacency.ts`. */
  readonly gates?: ReadonlyArray<GateRequirement>;
  /** §14 placement-time material cost. Multi-resource basket charged at
   *  `placeBuilding` time; demolition refunds 50% (floor) of each entry
   *  in addition to the §6.7 scrap credit. Tier-shaped baskets:
   *   - T1: stone + wood
   *   - T2: + iron_ingot
   *   - T3: + steel + microchip
   *   - T4: + steel + microchip + glass
   *   - T5: + reality_anchor + (T5 components like gear / wire / microchip)
   *   - T6: + antimatter_propellant + reality_anchor + steel
   *  Per-def adjustments scale with footprint area and complexity. Values
   *  are §14 placeholders — tune in Appendix A. Buildings without a cost
   *  (undefined) place for free; this exists as a defensive
   *  forward-compatibility hook (no shipped def currently leaves it
   *  undefined). */
  readonly placementCost?: Partial<Record<ResourceId, number>>;
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
    footprint: SHAPES.square2,
    fill: 0x9a9a9a,
    stroke: 0x222222,
    power: { consumes: 40 },
    requiredTile: ['ore', 'coal'],
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
    // §4.5 placeholder — tune in Appendix A. Mild clustering bonus rewards
    // packing mines onto adjacent ore/coal veins.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ],
  },
  // §8.1 T2 extraction: Deep Mine (2x3, ore vein tile). Higher ore yield
  // than T1 Mine. Skill-tree Mining sub-path gate per §8.1 is enforced
  // separately by `buildingUnlocked` once the catalog ships.
  deep_mine: {
    id: 'deep_mine',
    displayName: 'Deep Mine',
    category: 'extraction',
    tier: 2,
    footprint: SHAPES.rect2x3,
    fill: 0x4a3a30, // darker stone-brown vs T1 mine
    stroke: 0x1a1308,
    power: { consumes: 120 },
    requiredTile: ['ore'],
    placementCost: { stone: 80, wood: 40, iron_ingot: 30 },
    glyph: '▦',
  },
  workshop: {
    id: 'workshop',
    displayName: 'Workshop',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xe07b3a,
    stroke: 0x6b2f00,
    power: { consumes: 60 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 40, wood: 20 },
    glyph: '⚙',
    // §4.5 placeholder — tune in Appendix A. Manufacturing co-location bonus:
    // small per-match rate boost up to three adjacent Workshops.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 5, maxMatches: 3 },
    ],
  },
  solar: {
    id: 'solar',
    displayName: 'Solar Panel',
    category: 'power',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xf2c84b,
    stroke: 0x6a4a00,
    // §2.7: solar-driven producer — output modulates by day-night cycle.
    // Day 1.0×, Dawn/Dusk 0.5×, Night 0.0×.
    power: { produces: 50, solar: true },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 20, wood: 10 },
    glyph: '☀',
  },
  coal_gen: {
    id: 'coal_gen',
    displayName: 'Coal Generator',
    category: 'power',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xd97a18,
    stroke: 0x4a2400,
    power: { produces: 100 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 50, wood: 25 },
    glyph: '⚡',
  },
  dock: {
    id: 'dock',
    displayName: 'Cargo Dock',
    category: 'logistics',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x3a7bd5,
    stroke: 0x0a2a55,
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 30, wood: 20 },
    glyph: '⚓',
  },
  dronepad: {
    id: 'dronepad',
    displayName: 'Drone Pad',
    category: 'logistics',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x4a6b78,
    stroke: 0x14222a,
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 25, wood: 15 },
    glyph: '⤴',
  },
  logger: {
    id: 'logger',
    displayName: 'Logger',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x2f5e2c,
    stroke: 0x0f2a0c,
    requiredTile: ['tree'],
    placementCost: { stone: 15, wood: 5 },
    glyph: '⌬',
  },
  // §8.1 T2 extraction: Heavy Logger (2x2, dense forest tile). Higher wood
  // throughput than the T1 Logger — see recipe below.
  // NOTE: dense_forest terrain is not yet emitted by the procedural generator,
  // so requiredTile uses 'tree' as a less-restrictive placeholder until
  // biomes.ts terrainAtForBiome surfaces dense_forest clusters.
  heavy_logger: {
    id: 'heavy_logger',
    displayName: 'Heavy Logger',
    category: 'extraction',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x1f4e1c, // darker forest green vs T1 logger
    stroke: 0x0a1e08,
    power: { consumes: 80 },
    requiredTile: ['tree'],
    placementCost: { stone: 60, wood: 30, iron_ingot: 20 },
    glyph: '⌬',
  },
  smelter: {
    id: 'smelter',
    displayName: 'Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x7a5050,
    stroke: 0x3a1a1a,
    power: { consumes: 50 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 50, wood: 20 },
    glyph: '△',
    // §4.5 placeholder — tune in Appendix A. Paired smelters share heat
    // efficiencies; gentle clustering bonus rewards a two-smelter line.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 10, maxMatches: 2 },
    ],
  },
  crate: {
    id: 'crate',
    displayName: 'Crate',
    category: 'storage',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x8a6a3a,
    stroke: 0x402a10,
    // §4.6 / §8.4: +100 cap on ONE player-chosen resource per instance.
    // Generic storage — each PlacedBuilding picks its `cargoLabel` and only
    // that resource's cap is raised.
    storage: { category: 'generic', capacity: 100 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 15, wood: 8 },
    glyph: '▦',
  },
  silo: {
    id: 'silo',
    displayName: 'Silo',
    category: 'storage',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa08a5a,
    stroke: 0x504028,
    // §4.6 / §8.4: +2000 cap, dry-goods category only. Bumps every resource
    // whose RESOURCE_STORAGE_CATEGORY === 'dry_goods'.
    storage: { category: 'dry_goods', capacity: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 40, wood: 15 },
    glyph: '▦',
  },
  biomass_plant: {
    id: 'biomass_plant',
    displayName: 'Biomass Plant',
    category: 'power',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x3e7a36,
    stroke: 0x1a3a16,
    power: { produces: 80 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 50, wood: 25 },
    glyph: '❀',
  },
  // §8.5 T1 power: Wind Turbine (1x1, coast tile). Free output — no fuel
  // consumption. Lower output than Solar's daytime peak; complements
  // night-hour solar gaps on coastal islands.
  wind_turbine: {
    id: 'wind_turbine',
    displayName: 'Wind Turbine',
    category: 'power',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xc0c8d0, // pale steel-blue
    stroke: 0x404850,
    power: { produces: 40 },
    requiredTile: ['water'],
    placementCost: { steel: 30, wood: 10 },
    glyph: '✦',
  },
  // §5.2 / §8.6: Coal Furnace — T1 fuel-burning heat source. Burns
  // `coalPerCycle × consumersServed` coal per 30s cycle (literal §5.2:
  // "fuel consumption multiplies by the number of heat consumers it currently
  // serves"). With 0 served consumers, burns no coal. No electrical
  // contribution — the Coal Furnace is a pre-electricity hot box. The
  // economy folds its served-count fuel burn directly into `consumption.coal`
  // after the per-recipe rate pass.
  coal_furnace: {
    id: 'coal_furnace',
    displayName: 'Coal Furnace',
    category: 'special',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x4a2820, // dark ember
    stroke: 0x1a0a08,
    heatSource: { freeOrCoal: 'coal', coalPerCycle: 1 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 30, wood: 10 },
    glyph: '♨',
  },
  // §5.2 / §8.6 / §3.5: Geothermal Vent — Volcanic-only T1 free heat source.
  // Doubles as a power producer per §8.5 — the spec lists it under both
  // "Power Generation" and "Heat Sources". Modeled here with a small (free)
  // power contribution and the free heat-source flag.
  geothermal_vent: {
    id: 'geothermal_vent',
    displayName: 'Geothermal Vent',
    category: 'power',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc04020, // magma orange
    stroke: 0x401005,
    power: { produces: 200 },
    requiredBiomes: ['volcanic'],
    heatSource: { freeOrCoal: 'free' },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 60, wood: 20 },
    glyph: '♨',
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
    footprint: SHAPES.square2,
    fill: 0xb88a5a,
    stroke: 0x4a3520,
    power: { consumes: 70 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 40, wood: 20 },
    glyph: '⚙',
  },
  // §8.8 / §12.2: Shipyard — T1 logistics building that launches §12 cargo
  // ships for settlement (and, later, T1 cargo routes). Requires at least
  // one footprint tile on water (coastal placement gate per §4.3).
  shipyard: {
    id: 'shipyard',
    displayName: 'Shipyard',
    category: 'logistics',
    tier: 1,
    footprint: SHAPES.square3,
    fill: 0x3a7bd5,
    stroke: 0x0a2a55,
    power: { consumes: 80 },
    // §14 placeholder — tune in Appendix A. 3×3 footprint scales the
    // base T1 cost up versus the 2×2 baseline.
    placementCost: { stone: 60, wood: 40 },
    coastal: true,
    glyph: '⚓',
  },
  // §8.8 / §12.2: Helipad — T2 logistics building that launches §12
  // helicopters for settlement. Faster than ships, no coastal requirement.
  helipad: {
    id: 'helipad',
    displayName: 'Helipad',
    category: 'logistics',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x6a8a9a,
    stroke: 0x1f3340,
    power: { consumes: 60 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 15 },
    glyph: 'H',
  },
  // §9.6 / §12.7: Patron Hub — T3 logistics building that enables Auto-
  // Patronage cargo routes at the 10-island NC milestone. The economy scans
  // for `patron_hub` presence in `_nearestPatronHub`; without it, settlement
  // arrivals get no automatic supply lines.
  patron_hub: {
    id: 'patron_hub',
    displayName: 'Patron Hub',
    category: 'logistics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xc8a040, // patron gold
    stroke: 0x4a3510,
    power: { consumes: 100 },
    placementCost: { steel: 50, gear: 20, microchip: 10, glass: 20 },
    glyph: '⚜',
  },
  // §8.8 T3 logistics: Airship Dock (3x3). T3 long-range airship-route
  // endpoint. Route capacity / range mechanics live alongside the existing
  // cargo / drone route infrastructure (§2.4); this def ships as a catalog
  // row so airship routes can be created from this building once the
  // T3 airship route-type is fully wired in routes-ui.ts.
  airship_dock: {
    id: 'airship_dock',
    displayName: 'Airship Dock',
    category: 'logistics',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xa09060, // ochre-zeppelin
    stroke: 0x303018,
    power: { consumes: 150 },
    placementCost: { steel: 200, gear: 30, glass: 20 },
    glyph: '⊿',
  },
  // §8.8 T4 logistics: Teleporter Pad (2x2). Paired-endpoint instant
  // transport per §2.4. Pairing UX + route-type wire-up are separate;
  // this def ships as a catalog row.
  teleporter_pad: {
    id: 'teleporter_pad',
    displayName: 'Teleporter Pad',
    category: 'logistics',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x9060e0, // teleporter violet
    stroke: 0x301060,
    power: { consumes: 800 },
    placementCost: { steel: 200, exotic_alloy: 10, microchip: 30 },
    glyph: '⊕',
  },
  // §8.8 T5 logistics: Spacetime Anchor (2x2). Logical island unification
  // per §13.3 — links two islands as one logical unit (zero-distance
  // transport). Activation + linkage mechanics are separate.
  spacetime_anchor: {
    id: 'spacetime_anchor',
    displayName: 'Spacetime Anchor',
    category: 'logistics',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x405080, // spacetime indigo
    stroke: 0x101020,
    power: { consumes: 1500 },
    placementCost: { spacetime_fragment: 5, exotic_alloy: 20, reality_anchor: 2 },
    glyph: '⧗',
  },
  // §8.8 T4 logistics: Power Substation (2x2). Inter-island power-cable
  // endpoint per §5.3 — required at both ends of a cable route to transmit
  // W-capacity between islands. The cable W-capacity transmission mechanic
  // ships in a follow-up task (§5.3 wire-up); the def is needed now so
  // routes-ui can offer "cable" as a route-type option.
  power_substation: {
    id: 'power_substation',
    displayName: 'Power Substation',
    category: 'logistics',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0xc08040, // substation amber
    stroke: 0x402010,
    power: { consumes: 60 },  // operating overhead; the cable transmission itself doesn't count here
    placementCost: { steel: 150, wire: 20, microchip: 5 },  // heavy_cable not yet in ResourceId catalog; substituted with wire
    glyph: '⚡',
  },
  // -------------------------------------------------------------------------
  // T2 (levels 5-15)
  // -------------------------------------------------------------------------
  coke_oven: {
    id: 'coke_oven',
    displayName: 'Coke Oven',
    category: 'smelting',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x6a5a48,
    stroke: 0x2a2014,
    power: { consumes: 60 },
    // §5.2: Coke Oven is a heat-driven smelter. Marked `requiresHeat` so it
    // needs an adjacent Coal Furnace / Geothermal Vent / Plasma Heater /
    // Fusion Core to operate. Per §7.1 the coke-making chain is heat-driven
    // ("Coal → Coke (Coke Oven)") in addition to the §8.2 catalog tagging.
    requiresHeat: true,
    // §4.5 gating adjacency demonstration: hard heat_source gate.
    gates: [{ matchType: 'heat_source', hard: true }],
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '▲',
  },
  blast_furnace: {
    id: 'blast_furnace',
    displayName: 'Blast Furnace',
    category: 'smelting',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x8a2a1a,
    stroke: 0x401005,
    power: { consumes: 100 },
    // §5.2 / §8.2: requires an adjacent Heat Source (Coal Furnace / Geothermal
    // Vent / Plasma Heater / Fusion Core). The economy gates this building's
    // effective rate on `resolveHeatAssignments`; without heat it stalls and
    // contributes 0 to P_consumed.
    requiresHeat: true,
    // §4.5 gating adjacency demonstration: hard heat_source gate.
    gates: [{ matchType: 'heat_source', hard: true }],
    // §14 placeholder — tune in Appendix A. 3×3 footprint bumps base T2.
    placementCost: { stone: 150, iron_ingot: 50, wood: 20 },
    glyph: '△',
  },
  steel_mill: {
    id: 'steel_mill',
    displayName: 'Steel Mill',
    category: 'smelting',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x6e7480,
    stroke: 0x2a2e36,
    power: { consumes: 120 },
    // §7.1: spec's "Pig iron + Scrap → Steel" includes Scrap as a co-input.
    // The §6.7 Scrap substitution is now handled by the Oxygen Converter.
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 150, iron_ingot: 60, wood: 20 },
    glyph: '△',
  },
  // §6.7: Oxygen Converter — T3 smelting building that consumes pig iron +
  // scrap + oxygen to produce steel at higher throughput than the Steel Mill.
  // §5.2 heat-source adjacency required.
  oxygen_converter: {
    id: 'oxygen_converter',
    displayName: 'Oxygen Converter',
    category: 'smelting',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x5a7a9a,
    stroke: 0x3a5a7a,
    power: { consumes: 40 },
    requiresHeat: true,
    placementCost: { steel: 10, gear: 5 },
    glyph: '△',
  },
  // §6.7 Slag reprocessing: T2 smelting (2×2). Consumes accumulated slag
  // (a steel_mill / blast_furnace byproduct) and recovers trace amounts
  // of gold/silver/rare-earth ores per the §6.7 "low yield" spec literal.
  // Power-driven (no heat-source adjacency required — this is electric
  // arc / chemical separation, not direct smelting).
  slag_reprocessor: {
    id: 'slag_reprocessor',
    displayName: 'Slag Reprocessor',
    category: 'smelting',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x707080,        // slate-grey (industrial waste)
    stroke: 0x303038,
    power: { consumes: 100 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 100, iron_ingot: 40, wood: 15 },
    glyph: '△',
  },
  assembler: {
    id: 'assembler',
    displayName: 'Assembler',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xff8c2a,
    stroke: 0x6e3500,
    power: { consumes: 80 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '⚙',
  },
  // §8.3 T3 manufacturing: Fabricator (3x3). Advanced components — motors,
  // actuators, hydraulic / pneumatic systems. Recipe assignment lands in
  // a later balance pass; the def itself ships now so the catalog row +
  // tier badge are visible at T3.
  fabricator: {
    id: 'fabricator',
    displayName: 'Fabricator',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x6878a0, // industrial blue-grey
    stroke: 0x202840,
    power: { consumes: 200 },
    placementCost: { steel: 120, gear: 30, microchip: 5 },
    glyph: '⚙',
  },
  // §8.3 T3 manufacturing: Precision Lab (3x3). Circuit boards, computing
  // modules. Recipe assignment lands in a later balance pass.
  precision_lab: {
    id: 'precision_lab',
    displayName: 'Precision Lab',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xa07868, // copper-tinted lab beige
    stroke: 0x402818,
    power: { consumes: 250 },
    placementCost: { steel: 100, glass: 40, microchip: 10 },
    glyph: '⌗',
  },
  // §8.3 T4 manufacturing: Singularity Forge (4x4). T4 endgame artifacts —
  // antimatter capsules, exotic alloy fragments, quantum chips. Recipe
  // assignment deferred to balance pass; def ships now for catalog row.
  singularity_forge: {
    id: 'singularity_forge',
    displayName: 'Singularity Forge',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square4,
    fill: 0x402060, // singularity violet
    stroke: 0x100020,
    power: { consumes: 600 },
    placementCost: { steel: 400, exotic_alloy: 5, quantum_chip: 10 },
    glyph: '✦',
  },
  tank: {
    id: 'tank',
    displayName: 'Tank',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x2a4078,
    stroke: 0x0a1a3a,
    // §4.6 / §8.4: +2000 cap, liquids/gases category only.
    storage: { category: 'liquid_gas', capacity: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '▦',
  },
  // §4.6 / §8.4: Cold Storage — T2 specialized storage for temperature-
  // sensitive resources (cryogenic compound, cryo-coolant, liquid nitrogen,
  // certain plastics). +1500 cap. Cool steel-grey fill keys to the
  // refrigeration role.
  cold_storage: {
    id: 'cold_storage',
    displayName: 'Cold Storage',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x8090a0,
    stroke: 0x2a3848,
    storage: { category: 'temp_sensitive', capacity: 1500 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 90, iron_ingot: 35, wood: 10 },
    glyph: '▦',
  },
  // §4.6 / §8.4: Component Warehouse — T2 specialized storage for
  // manufactured T2-T3 components (wire, bolt, gear, microchip, etc.).
  // +2000 cap. Industrial-tan fill keys to the parts-warehouse role.
  component_warehouse: {
    id: 'component_warehouse',
    displayName: 'Component Warehouse',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x806840,
    stroke: 0x3a2810,
    storage: { category: 'components', capacity: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '▦',
  },
  // §3.4 / §8.9: Land Reclamation Hub — T2 trigger building (3×3 per §8.9
  // catalog row). Placement enables the inspector's "+1 major / +1 minor"
  // expansion controls; the building itself has no recipe and no
  // continuous power draw. Per §3.4 each expansion costs material that
  // scales superlinearly with current radius; the cost curve lives in
  // `land-reclamation.ts` (§3.4 placeholder, see `landReclamationCost`).
  // Multiple Hubs on one island do not stack — the inspector exposes a
  // single expansion control per island regardless of how many Hubs are
  // placed (the gate is "at least one Hub present").
  land_reclamation_hub: {
    id: 'land_reclamation_hub',
    displayName: 'Land Reclamation Hub',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x5a8a6a, // verdant reclamation green
    stroke: 0x1a3020,
    // §14 placeholder — tune in Appendix A. 3×3 footprint bumps T2 base.
    placementCost: { stone: 150, iron_ingot: 50, wood: 30 },
    glyph: '⊕',
  },
  // §8.9 T2 special: Terrain Modifier (2x2). Clears or converts tiles per
  // §8.9. The tile-conversion mechanic is a separate UI action; this def
  // ships as a catalog row.
  terrain_modifier: {
    id: 'terrain_modifier',
    displayName: 'Terrain Modifier',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x804040, // earth-tone modifier
    stroke: 0x200810,
    power: { consumes: 100 },
    placementCost: { steel: 50, gear: 20 },
    glyph: '◈',
  },
  // §8.5 T2 power: Cryogenic Generator (2x2, ice tile / arctic). Consumes
  // cryo_coolant as fuel. High output among T2 power options when an Arctic
  // colony's cryo chain is active.
  cryogenic_generator: {
    id: 'cryogenic_generator',
    displayName: 'Cryogenic Generator',
    category: 'power',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x70c0e0, // cryo cyan
    stroke: 0x103060,
    power: { produces: 400 },
    requiredTile: ['ice'],
    placementCost: { steel: 80, gear: 20, glass: 15 },
    glyph: '❄',
  },
  // -------------------------------------------------------------------------
  // T3 (levels 15-30)
  // -------------------------------------------------------------------------
  // §5.2 / §8.6: Plasma Heater — T3 free heat source (power-driven, no fuel).
  // Costs 200W to operate but serves any number of adjacent consumers at no
  // additional cost. Bridges the gap between T1 Coal Furnace (cheap, fuel-
  // intensive) and T4 Fusion Core (massive output, free).
  plasma_heater: {
    id: 'plasma_heater',
    displayName: 'Plasma Heater',
    category: 'special',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xa040a0, // plasma magenta
    stroke: 0x401040,
    power: { consumes: 200 },
    heatSource: { freeOrCoal: 'free' },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 120, microchip: 40, stone: 30 },
    glyph: '♨',
  },
  electric_arc_furnace: {
    id: 'electric_arc_furnace',
    displayName: 'Electric Arc Furnace',
    category: 'smelting',
    tier: 3,
    footprint: SHAPES.rect2x3,
    fill: 0x4a8ae0,
    stroke: 0x1a3a78,
    power: { consumes: 200 },
    // §5.2: T3 arc furnaces still rely on adjacent heat per the spec's
    // smelting-category convention. Gated like Blast Furnace / Pyroforge.
    requiresHeat: true,
    // §4.5 gating adjacency demonstration: hard heat_source gate.
    gates: [{ matchType: 'heat_source', hard: true }],
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 100, microchip: 50, stone: 20 },
    glyph: '△',
  },
  // §4.6 / §8.4: Vault — T3 specialized storage for rare/valuable resources
  // (helium_3, AI core, exotic alloy, T5 raws/components). +5000 cap.
  // Dusky-violet fill — high-security vault aesthetic, tracking the "rare"
  // category.
  vault: {
    id: 'vault',
    displayName: 'Vault',
    category: 'storage',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x504860,
    stroke: 0x1a1830,
    storage: { category: 'rare', capacity: 5000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 150, microchip: 50, stone: 30 },
    glyph: '▦',
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
    footprint: SHAPES.square4,
    fill: 0x6a4a8c, // dusky violet — "foundry"-coded
    stroke: 0x2a1a40,
    power: { consumes: 200 },
    // §14 placeholder — tune in Appendix A. 4×4 footprint bumps T3 base.
    placementCost: { steel: 200, microchip: 80, stone: 40 },
    glyph: '⬢',
  },
  // §8.5 T3 power: Nuclear Reactor (4x4, any tile). Consumes uranium fuel
  // rods (or placeholder fuel if uranium_ore / nuclear_fuel_rod aren't in
  // the catalog yet — see the recipe note). Very high output — the
  // workhorse T3 power option for non-volcanic / non-arctic biomes.
  nuclear_reactor: {
    id: 'nuclear_reactor',
    displayName: 'Nuclear Reactor',
    category: 'power',
    tier: 3,
    footprint: SHAPES.square4,
    fill: 0x80b070, // reactor green
    stroke: 0x204010,
    power: { produces: 2000 },
    placementCost: { steel: 400, microchip: 20, glass: 30 },
    glyph: '☢',
  },
  // §8.7 T2 cooling: Cooling Tower (2x2). Adjacency anchor — required for
  // some chemistry recipes (e.g. Crystal Growth Lab → rare crystals per
  // §4.5). The adjacency-effect wire-up that recipe-unlocks downstream
  // buildings is deferred; this def ships as a catalog row so the player
  // can place it now in anticipation of those gates landing.
  cooling_tower: {
    id: 'cooling_tower',
    displayName: 'Cooling Tower',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x6090c0, // cool-blue tower
    stroke: 0x102040,
    power: { consumes: 40 },
    placementCost: { steel: 60, glass: 20, gear: 10 },
    glyph: '❅',
  },
  // §8.7 T2 treatment: Wastewater Treatment (2x2). Adjacency anchor —
  // prevents efficiency penalty for chemistry per §4.5 ("Refinery without
  // adjacent Wastewater Treatment operates only on low-grade recipe,
  // efficiency -50%"). Soft-gate wire-up on downstream chemistry recipes
  // is deferred; def ships as a catalog row.
  wastewater_treatment: {
    id: 'wastewater_treatment',
    displayName: 'Wastewater Treatment',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x4a7060, // murky water-treatment teal
    stroke: 0x0a1810,
    power: { consumes: 30 },
    placementCost: { steel: 50, gear: 10 },
    glyph: '⌇',
  },
  // §8.7 T2 emissions: Exhaust Scrubber (1x1). Required for clean operation
  // of high-emission buildings per §8.7. Adjacency wire-up is deferred to
  // the §4.5 gate-system extension; this def ships as a catalog row.
  exhaust_scrubber: {
    id: 'exhaust_scrubber',
    displayName: 'Exhaust Scrubber',
    category: 'special',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x807060, // smokestack grey-brown
    stroke: 0x201810,
    power: { consumes: 20 },
    placementCost: { steel: 30, gear: 5 },
    glyph: '⌗',
  },
  // -------------------------------------------------------------------------
  // T4 (levels 30-50) — endgame chain per §6.5 / §8.5 / §9.5
  // -------------------------------------------------------------------------
  // §8.5: Fusion Core — universal T4 power source, Helium-3 fuel, massive
  // output (5000W). Not biome-locked. Per §5.2 / §8.5 also acts as a free
  // Heat Source — the `heatSource` flag below makes adjacent heat consumers
  // operate at zero fuel cost, in addition to the building's electrical
  // contribution.
  fusion_core: {
    id: 'fusion_core',
    displayName: 'Fusion Core',
    category: 'power',
    tier: 4,
    footprint: SHAPES.square4,
    fill: 0x4a90c8, // cool electric blue
    stroke: 0x1a3050,
    power: { produces: 5000 },
    heatSource: { freeOrCoal: 'free' },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 400, microchip: 150, glass: 50 },
    glyph: '⚡',
  },
  // §9.5: Pyroforge — Volcanic-unique. Only producer of Exotic Alloy in the
  // world. §5.2 heat-source adjacency gated: a Pyroforge without an adjacent
  // Heat Source stalls. Volcanic-only siting makes Geothermal Vents the
  // natural pairing.
  pyroforge: {
    id: 'pyroforge',
    displayName: 'Pyroforge',
    category: 'smelting',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0xc04020, // lava red
    stroke: 0x2a0800,
    power: { consumes: 800 },
    requiredBiomes: ['volcanic'],
    requiresHeat: true,
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 300, microchip: 100, glass: 30 },
    glyph: '◉',
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
    footprint: SHAPES.square4,
    fill: 0xa0e0e8, // icy cyan
    stroke: 0x205060,
    power: { consumes: 1200 },
    requiredBiomes: ['arctic'],
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 400, microchip: 150, glass: 50 },
    glyph: '◈',
  },
  // §9.5: Mass Driver — Plains-unique T4. Long-range cargo route launcher
  // (~5× airship capacity per spec). Consumes Diesel per dispatch volume.
  // One per Plains island. The route-type wire-up (mass_driver as RouteType)
  // ships separately; this def is the catalog row + biome lock.
  mass_driver: {
    id: 'mass_driver',
    displayName: 'Mass Driver',
    category: 'logistics',
    tier: 4,
    footprint: SHAPES.square4,
    fill: 0x707080, // industrial steel-grey
    stroke: 0x202028,
    power: { consumes: 600 },
    requiredBiomes: ['plains'],
    placementCost: { steel: 500, gear: 80, microchip: 30 },
    glyph: '➶',
  },
  // §9.5: Carbon Forge — Forest-unique T4. Only producer of Carbon Fiber /
  // Glass Fiber / Optical Fiber. Forest's wood/charcoal abundance feeds the
  // chain. Heavy power draw; requires adjacent Heat Source per §9.5.
  carbon_forge: {
    id: 'carbon_forge',
    displayName: 'Carbon Forge',
    category: 'smelting',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x303030, // deep carbon-black
    stroke: 0x080808,
    power: { consumes: 700 },
    requiredBiomes: ['forest'],
    requiresHeat: true,
    placementCost: { steel: 250, microchip: 80, glass: 40 },
    glyph: '⬢',
  },
  // §9.5: Tidal Array — Coast-unique T4 renewable power. Massive constant
  // output (50 MW placeholder). No fuel cost. Coastal water-tile siting.
  tidal_array: {
    id: 'tidal_array',
    displayName: 'Tidal Array',
    category: 'power',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x3878a8, // tidal blue
    stroke: 0x0a2848,
    power: { produces: 50000 },  // 50 MW placeholder
    requiredBiomes: ['coast'],
    requiredTile: ['water'],     // coastal water tile (the project uses 'water' for shoreline; see Wind Turbine precedent)
    placementCost: { steel: 350, gear: 60, microchip: 20 },
    glyph: '≋',
  },
  // §9.5: Sunspire — Desert-unique T4 renewable power. Peak solar output
  // (60 MW placeholder). No fuel cost. Composes with Solar Panel's per-tile
  // solar bonus for Desert-dominant power islands.
  sunspire: {
    id: 'sunspire',
    displayName: 'Sunspire',
    category: 'power',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0xf0c050, // solar gold
    stroke: 0x402810,
    power: { produces: 60000 },  // 60 MW placeholder
    requiredBiomes: ['desert'],
    placementCost: { steel: 250, glass: 100, microchip: 25 },
    glyph: '☀',
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
    footprint: SHAPES.square4,
    fill: 0x8060c0, // deep violet
    stroke: 0x301050,
    power: { consumes: 1500 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 400, microchip: 150, glass: 50 },
    glyph: '◈',
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
    footprint: SHAPES.square3,
    fill: 0x8a8a40, // dull sand-gold
    stroke: 0x303010,
    power: { consumes: 400 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 300, microchip: 100, glass: 30 },
    glyph: '▲',
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
    footprint: SHAPES.square2,
    fill: 0x3a0a4a, // deep void violet
    stroke: 0x100020,
    power: { produces: 8000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 50, steel: 100, microchip: 50 },
    glyph: '⚡',
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
    footprint: SHAPES.square4,
    fill: 0x6020a0, // amethyst violet
    stroke: 0x100040,
    power: { consumes: 3000 },
    // §14 placeholder — tune in Appendix A. 4×4 footprint bumps T5 base.
    placementCost: { reality_anchor: 100, steel: 200, microchip: 100 },
    glyph: '✺',
  },
  // §8.4: Singularity Battery — "effectively infinite electrical power
  // storage" per spec. Power-storage mechanic per §13.3 DEFERRED to step 14+.
  // Per the §8.4 note ("not a resource storage building") this def carries
  // NO `storage` contribution — it never raised any resource cap. The earlier
  // step-13 `storageCap: 10000` placeholder is removed by the §4.6
  // categorized-storage cleanup; resource caps are now category-routed and
  // a power-buffer doesn't fit any category. Tiny consumption (100W) models
  // continuous standby overhead.
  singularity_battery: {
    id: 'singularity_battery',
    displayName: 'Singularity Battery',
    category: 'power',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x202060, // deep ultramarine
    stroke: 0x0a0a30,
    power: { consumes: 100 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 50, steel: 100, microchip: 50 },
    glyph: '▦',
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
    footprint: SHAPES.square3,
    fill: 0xc080e0, // pale aurora violet
    stroke: 0x400060,
    power: { consumes: 1500 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✺',
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
    footprint: SHAPES.square4,
    fill: 0xa0e0a0, // ethereal green
    stroke: 0x205020,
    power: { consumes: 2500 },
    // §14 placeholder — tune in Appendix A. 4×4 footprint bumps T5 base.
    placementCost: { reality_anchor: 100, steel: 200, microchip: 100 },
    glyph: '✺',
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
    footprint: SHAPES.square3,
    fill: 0xff80a0, // rose-pink
    stroke: 0x500020,
    power: { consumes: 4000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✺',
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
    footprint: SHAPES.square2,
    fill: 0x80f0c0, // mint-cyan
    stroke: 0x205040,
    power: { consumes: 800 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 50, steel: 100, microchip: 50 },
    glyph: '✺',
  },
  // §11.6: Path Drone Foundry — T5 logistics building that launches path-
  // drawn drones with waypoints. No recipe; the launch action is driven by
  // the UI invoking `dispatchDrone` with a `waypoints` array.
  path_drone_foundry: {
    id: 'path_drone_foundry',
    displayName: 'Path Drone Foundry',
    category: 'logistics',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x4a6b78,
    stroke: 0x14222a,
    power: { consumes: 50 },
    placementCost: { steel: 50, microchip: 20, quantum_chip: 2 },
    glyph: '✈',
  },
  // §13.3: Probability Engine — boosts effective scan radius for rare islands
  // (islands with modifiers) via `probabilityBiasForIsland`.
  probability_engine: {
    id: 'probability_engine',
    displayName: 'Probability Engine',
    category: 'special',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x9070c0, // exotic violet
    stroke: 0x301050,
    power: { consumes: 80 },
    placementCost: { steel: 40, quantum_chip: 4, exotic_alloy: 10 },
    glyph: '⚄',
  },
  // §13.4 / §14.1: Ascendant Assembly — T5 building dedicated to crafting
  // the Ascendant Core. Spec §13.4 describes the Core as "constructed"
  // from T5 inputs once the player has mastered T5; ship it as a
  // standalone defId with its own recipe (parallel to the step-12
  // Foundation Kit decision to split kit_assembler from Workshop) so the
  // engine's 1:1 recipe-per-defId model has no conflict. Crafting one
  // Ascendant Core flips the §14.1 `ascendantCoreCrafted` gate (auto-flip
  // lives at `economy.ts:1118` on first `ascendant_core` production; forest-ne
  // demo seeds the flag via main.ts for DEMO callers).
  ascendant_assembly: {
    id: 'ascendant_assembly',
    displayName: 'Ascendant Assembly',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square4,
    fill: 0xe0c060, // ascendant gold
    stroke: 0x504010,
    power: { consumes: 4000 },
    // §14 placeholder — tune in Appendix A. 4×4 footprint bumps T5 base.
    placementCost: { reality_anchor: 100, steel: 200, microchip: 100 },
    glyph: '✺',
  },
  // -------------------------------------------------------------------------
  // T6 (Ascendant Core + Spaceport, §14) — Orbital per step 20
  // -------------------------------------------------------------------------
  //
  // Data-only ship. The §14.2-14.8 / §14.12 live mechanics — Spaceport
  // tier I/II/III upgrade lifecycle, satellite launches as a concurrent
  // slot, scheduled launches with success rolls, orbital debris fields,
  // Kessler-cascade chains, comm-graph data delivery, lodge events,
  // Repair Drone operations, dwell-ramp discovery — are all DEFERRED.
  // §14.9 four new Orbital skill sub-paths (Launch / Communication /
  // Discovery / Resilience) — DEFERRED.
  //
  // The §14.1 access gate (level 50 + AI core + Ascendant Core crafted +
  // Spaceport placed) is composed in `buildingUnlocked` below. Spaceport
  // itself is exempt from the "Spaceport placed" half of the gate
  // (otherwise it'd be unbuildable — chicken-and-egg per §14.1's literal
  // reading).

  // §14.2 Spaceport — single building serving as launch facility, ground-
  // side comm antenna, and repair-launch facility. Tier I/II/III in-place
  // upgrade lifecycle per §14.2 DEFERRED — ships as a single tier with no
  // upgrade. §14.7 pad-explosion failure (Spaceport returns to tier I on
  // destruction) — DEFERRED. No recipe — this is a special placement
  // (the T6 gate building itself).
  spaceport: {
    id: 'spaceport',
    displayName: 'Spaceport',
    category: 'special',
    tier: 6,
    footprint: SHAPES.square4,
    fill: 0x202060, // deep cosmic blue
    stroke: 0x080018,
    power: { consumes: 3000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 100, steel: 200, reality_anchor: 100 },
    glyph: '▲',
  },
  // §14.2 Orbital Tracking Station: T6 ground-based radar (3×3). Detects
  // orbital debris within ORBITAL_TRACKING_DETECTION_RADIUS_TILES of the
  // island. Multiple stations across islands compose into a network. The
  // debris-mechanics consumer lives in src/orbital.ts (see
  // debrisDetectionRangeForIsland).
  orbital_tracking_station: {
    id: 'orbital_tracking_station',
    displayName: 'Orbital Tracking Station',
    category: 'special',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x4080a0,        // radar-blue
    stroke: 0x102030,
    power: { consumes: 80 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 200, microchip: 80, glass: 30 },
    glyph: '◉',
  },
  // §11.7 / §14.10: Antimatter Refinery — produces Antimatter Propellant
  // (T6 launch fuel). Recipe placeholder per the task brief:
  // `1 exotic_alloy + 1 reality_anchor + 2 casimir_energy → 1 antimatter_propellant`
  // on a 2-hour cycle. §14.10 actual recipe ("Antimatter Capsule" chain
  // through Particle Accelerator) — DEFERRED.
  antimatter_refinery: {
    id: 'antimatter_refinery',
    displayName: 'Antimatter Refinery',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xc060e0, // electric violet
    stroke: 0x300040,
    power: { consumes: 5000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 75, steel: 150, reality_anchor: 75 },
    glyph: '✦',
  },
  // §14.3 / §14.10: Scanner Sat Assembly — produces Scanner Sat payloads
  // for §14.3 discovery + weather observation. Recipe:
  // `4 exotic_alloy + 2 ai_core + 1 spacetime_fragment + 50 steel + 1
  // orbital_insertion_package` on a 60-min (3600s) cycle.
  scanner_sat_assembly: {
    id: 'scanner_sat_assembly',
    displayName: 'Scanner Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x80a0c0, // pale instrument blue
    stroke: 0x20303a,
    power: { consumes: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 75, steel: 150, reality_anchor: 75 },
    glyph: '◇',
  },
  // §14.3 / §14.10: Comm Sat Assembly — produces Comm Sat payloads for
  // §14.4 comm-graph extension. Recipe:
  // `6 exotic_alloy + 1 ai_core + 200 wire + 1 orbital_insertion_package`
  // on a 60-min (3600s) cycle.
  comm_sat_assembly: {
    id: 'comm_sat_assembly',
    displayName: 'Comm Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xa0c080, // pale antenna green
    stroke: 0x303a20,
    power: { consumes: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 75, steel: 150, reality_anchor: 75 },
    glyph: '◇',
  },
  // §14.7 / §14.10: Orbital Insertion Assembly — produces Orbital
  // Insertion Packages (T6 Foundation-Kit equivalent). Every §14.7
  // satellite launch requires one alongside fuel + variant recipe. Recipe:
  // `100 iron_ingot + 30 stone + 20 glass + 10 pcb + 5 ai_core` on a
  // 30-min (1800s) cycle.
  orbital_insertion_assembly: {
    id: 'orbital_insertion_assembly',
    displayName: 'Orbital Insertion Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xc0a060, // bronze
    stroke: 0x403014,
    power: { consumes: 1500 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 75, steel: 150, reality_anchor: 75 },
    glyph: '⚙',
  },
  // §14.3 / §14.10: Sweeper Sat Assembly — produces Sweeper Sat payloads
  // for §14.8 debris-field / Kessler-cascade clearing. Recipe:
  // `4 exotic_alloy + 1 ai_core + 100 steel + 20 gear + 1
  // orbital_insertion_package` on a 60-min (3600s) cycle.
  sweeper_sat_assembly: {
    id: 'sweeper_sat_assembly',
    displayName: 'Sweeper Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x80a0a0, // pale teal
    stroke: 0x203030,
    power: { consumes: 2000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 75, steel: 150, reality_anchor: 75 },
    glyph: '◇',
  },
  // §14.12 / §14.10: Repair Pack Assembly — produces Repair Pack consumables
  // for orbital drone repair operations. Recipe:
  // `50 steel + 10 gear + 2 exotic_alloy + 5 microchip` on a 30-min (1800s)
  // cycle.
  repair_pack_assembly: {
    id: 'repair_pack_assembly',
    displayName: 'Repair Pack Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square2,
    fill: 0xc08060, // warm copper
    stroke: 0x402818,
    power: { consumes: 1200 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 50, steel: 100, reality_anchor: 50 },
    glyph: '⚙',
  },
  // -------------------------------------------------------------------------
  // Step-18 recipe-graph closure (§7.1-§7.12)
  // -------------------------------------------------------------------------
  // One defId per recipe. Step-18 prioritises COVERAGE (every recipe input
  // has a producer) over balance — cycle times, power draws, and footprints
  // are placeholders pending the rebalance pass. §8.1 tile-gating is now
  // live for all extractors.

  // T1 extraction (§8.1 raws).
  quarry: {
    id: 'quarry',
    displayName: 'Quarry',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa8a094, // pale stone-grey
    stroke: 0x403828,
    power: { consumes: 30 },
    requiredTile: ['stone'],
    placementCost: { stone: 25, wood: 15 },
    glyph: '▣',
  },
  sand_pit: {
    id: 'sand_pit',
    displayName: 'Sand Pit',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xe0c878, // dune-tan
    stroke: 0x6a5028,
    power: { consumes: 20 },
    requiredTile: ['sand'],
    placementCost: { stone: 25, wood: 15 },
    glyph: '▣',
  },
  well: {
    id: 'well',
    displayName: 'Well',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x4a8ac0, // freshwater blue
    stroke: 0x1a3a60,
    power: { consumes: 10 },
    requiredTile: ['water'],
    placementCost: { stone: 10, wood: 5 },
    glyph: '◌',
  },
  coastal_pump: {
    id: 'coastal_pump',
    displayName: 'Coastal Pump',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x2a7090, // brine-teal
    stroke: 0x0a2030,
    power: { consumes: 15 },
    requiredTile: ['water'],
    placementCost: { stone: 15, wood: 5 },
    glyph: '⛽',
  },
  quartz_mine: {
    id: 'quartz_mine',
    displayName: 'Quartz Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xb0b8d0, // pale silica-grey
    stroke: 0x484858,
    power: { consumes: 30 },
    requiredTile: ['stone'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },
  limestone_quarry: {
    id: 'limestone_quarry',
    displayName: 'Limestone Quarry',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc8c0a8, // pale calcareous beige
    stroke: 0x60584a,
    power: { consumes: 30 },
    requiredTile: ['limestone'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },
  clay_pit_extractor: {
    id: 'clay_pit_extractor',
    displayName: 'Clay Pit Extractor',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa67555, // earthen red
    stroke: 0x5a3a2a,
    power: { consumes: 30 },
    requiredTile: ['clay_pit'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },
  sulfur_mine: {
    id: 'sulfur_mine',
    displayName: 'Sulfur Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xd0c020, // pale sulfur-yellow
    stroke: 0x605810,
    power: { consumes: 30 },
    requiredTile: ['sulfur_vein'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },
  phosphate_mine: {
    id: 'phosphate_mine',
    displayName: 'Phosphate Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xd5b04a, // mustard-tan
    stroke: 0x6a5018,
    power: { consumes: 30 },
    requiredTile: ['phosphate_deposit'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },
  graphite_mine: {
    id: 'graphite_mine',
    displayName: 'Graphite Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x2a2a2e, // anthracite gray
    stroke: 0x101012,
    power: { consumes: 30 },
    requiredTile: ['graphite_vein'],
    placementCost: { stone: 30, wood: 15 },
    glyph: '⛏',
  },

  // T1 manufacturing / chemistry.
  lumber_mill: {
    id: 'lumber_mill',
    displayName: 'Lumber Mill',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x8a5a30, // sawn-wood ochre
    stroke: 0x3a2010,
    power: { consumes: 40 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 30, wood: 30 },
    glyph: '⌬',
  },
  glassworks: {
    id: 'glassworks',
    displayName: 'Glassworks',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa8d0e0, // pane-cyan
    stroke: 0x305060,
    power: { consumes: 80 },
    // §5.2 mentions Glassworks heat dependence; this step's scope is the
    // iron/steel chain. Glassworks runs without an adjacent heat source for
    // now — `requiresHeat` left unset intentionally.
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 50, wood: 20 },
    glyph: '▲',
  },
  evaporator: {
    id: 'evaporator',
    displayName: 'Evaporator',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xf0e0a0, // salt-pan tan
    stroke: 0x605030,
    power: { consumes: 25 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 15, wood: 8 },
    glyph: '◇',
  },
  electrolyzer: {
    id: 'electrolyzer',
    displayName: 'Electrolyzer',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xa0c0e8, // electrolyte blue
    stroke: 0x303a60,
    power: { consumes: 100 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 25, wood: 10 },
    glyph: '◇',
  },
  biofuel_plant: {
    id: 'biofuel_plant',
    displayName: 'Biofuel Plant',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x408a30, // bioreactor green
    stroke: 0x1a3a10,
    power: { consumes: 60 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 40, wood: 20 },
    glyph: '❀',
  },

  // T2 extraction.
  pump_jack: {
    id: 'pump_jack',
    displayName: 'Pump Jack',
    category: 'extraction',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x2a1a14, // crude-oil black-brown
    stroke: 0x080404,
    power: { consumes: 80 },
    requiredTile: ['oil_well'],
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '⛽',
  },
  gas_extractor: {
    id: 'gas_extractor',
    displayName: 'Gas Extractor',
    category: 'extraction',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x707a40, // sulfur-yellow-grey
    stroke: 0x2a2810,
    power: { consumes: 70 },
    requiredTile: ['gas_seep'],
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '◇',
  },

  // T2 petrochemical / refining.
  naphtha_cracker: {
    id: 'naphtha_cracker',
    displayName: 'Naphtha Cracker',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x6a4a20, // refinery brown
    stroke: 0x2a1a08,
    power: { consumes: 200 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 150, iron_ingot: 50, wood: 20 },
    glyph: '◇',
  },
  chlor_alkali_plant: {
    id: 'chlor_alkali_plant',
    displayName: 'Chlor-Alkali Plant',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x80d050, // chlorine-green
    stroke: 0x305018,
    power: { consumes: 150 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '◇',
  },
  // §8.2 T2 chemistry: Chemical Reactor (2×2, any tile). Spec lists three
  // example outputs ("Acid, plastic precursor, alumina") — those resource
  // ids aren't in the catalog yet. Placeholder recipe ships the §7.5
  // electrolysis chain (Salt + power → Chlorine), which keeps the
  // building tickable. Primary purpose: serve as the adjacency anchor for
  // the §4.5 toxicity event (mechanic implemented in a later task).
  chemical_reactor: {
    id: 'chemical_reactor',
    displayName: 'Chemical Reactor',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xc06030,         // rust-orange (corrosive-coded)
    stroke: 0x401810,
    power: { consumes: 160 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 100, iron_ingot: 40, wood: 15 },
    glyph: '◇',
  },
  lubricant_refinery: {
    id: 'lubricant_refinery',
    displayName: 'Lubricant Refinery',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x4a3018, // viscous-oil brown
    stroke: 0x1a1008,
    power: { consumes: 120 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '◇',
  },
  diesel_refinery: {
    id: 'diesel_refinery',
    displayName: 'Diesel Refinery',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x504030, // diesel-tan brown
    stroke: 0x201810,
    power: { consumes: 180 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 80, iron_ingot: 30, wood: 10 },
    glyph: '◇',
  },
  metal_rolling_mill: {
    id: 'metal_rolling_mill',
    displayName: 'Metal Rolling Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x8090a0, // steel-roll grey
    stroke: 0x2a3848,
    power: { consumes: 200 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { stone: 100, iron_ingot: 40, wood: 15 },
    glyph: '⚙',
  },

  // T3 chemistry / electronics / extraction.
  silicon_crusher: {
    id: 'silicon_crusher',
    displayName: 'Silicon Crusher',
    category: 'smelting',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x686878, // metallic-silicon grey
    stroke: 0x202028,
    power: { consumes: 250 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 100, microchip: 50, stone: 20 },
    glyph: '◈',
  },
  air_separator: {
    id: 'air_separator',
    displayName: 'Air Separator',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xc8e8f0, // pale-cyan condenser
    stroke: 0x405058,
    power: { consumes: 300 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 150, microchip: 60, stone: 30 },
    glyph: '❄',
  },
  cryo_lab: {
    id: 'cryo_lab',
    displayName: 'Cryo Lab',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x80c0e8, // cryo-pale-blue
    stroke: 0x204060,
    power: { consumes: 400 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 150, microchip: 60, stone: 30 },
    glyph: '❄',
  },
  cryo_compressor: {
    id: 'cryo_compressor',
    displayName: 'Cryo Compressor',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x6080b0, // compressed-fluid blue
    stroke: 0x182840,
    power: { consumes: 500 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 150, microchip: 60, stone: 30 },
    glyph: '❄',
  },
  kerosene_refinery: {
    id: 'kerosene_refinery',
    displayName: 'Kerosene Refinery',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x9080a0, // aviation-fuel purple-grey
    stroke: 0x302840,
    power: { consumes: 350 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { steel: 150, microchip: 50, stone: 30 },
    glyph: '◇',
  },
  lithography_lab: {
    id: 'lithography_lab',
    displayName: 'Lithography Lab',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square4,
    fill: 0x40a0c0, // wafer-fab cyan
    stroke: 0x103040,
    power: { consumes: 600 },
    // §14 placeholder — tune in Appendix A. 4×4 footprint bumps T3 base.
    placementCost: { steel: 200, microchip: 100, stone: 40 },
    glyph: '◈',
  },
  drilling_rig: {
    id: 'drilling_rig',
    displayName: 'Drilling Rig',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xa07050, // rig-rust brown
    stroke: 0x401810,
    power: { consumes: 400 },
    requiredTile: ['helium_vent'],
    placementCost: { steel: 150, microchip: 50, stone: 30 },
    glyph: '⛏',
  },

  // T5 raw extractors (§8.10). Power draws are placeholder "60-100 kW"
  // figures per §8.10 — these are the biggest power loads in the catalog
  // and will brownout most networks until fed Casimir Taps / Singularity
  // Batteries. Multi-output rotation across §6.6 raws DEFERRED.
  aetheric_conduit: {
    id: 'aetheric_conduit',
    displayName: 'Aetheric Conduit',
    category: 'special',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x80a0e0, // aetheric pale-blue
    stroke: 0x203060,
    power: { consumes: 60000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✦',
  },
  spacetime_resonator: {
    id: 'spacetime_resonator',
    displayName: 'Spacetime Resonator',
    category: 'special',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0xa080e0, // tachyon violet
    stroke: 0x301040,
    power: { consumes: 100000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✦',
  },
  eldritch_sieve: {
    id: 'eldritch_sieve',
    displayName: 'Eldritch Sieve',
    category: 'special',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x402040, // dark-matter near-black
    stroke: 0x100008,
    power: { consumes: 80000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✦',
  },

  // T5 refining (§7.12). One def per refining recipe — same rationale
  // as the T2 split.
  plasma_forge: {
    id: 'plasma_forge',
    displayName: 'Plasma Forge',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0xe06030, // plasma-orange
    stroke: 0x401008,
    power: { consumes: 4000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✺',
  },
  eldritch_refiner: {
    id: 'eldritch_refiner',
    displayName: 'Eldritch Refiner',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x603060, // eldritch-violet
    stroke: 0x201020,
    power: { consumes: 5000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✺',
  },
  phase_refiner: {
    id: 'phase_refiner',
    displayName: 'Phase Refiner',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x4060a0, // phase-blue
    stroke: 0x10204a,
    power: { consumes: 5000 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 75, steel: 150, microchip: 75 },
    glyph: '✺',
  },
  // -------------------------------------------------------------------------
  // Lighthouse vision (§15.x). Six tiers extending the baseline 10-tile
  // padding ellipse. Vision radius (in tiles) lives in lighthouse.ts →
  // LIGHTHOUSE_VISION_RADII; the economy doesn't read it. Recipes / build
  // costs are deferred — placement is free pre-§14, and once §14 costs land
  // the table below moves into `def.placementCost`:
  //
  //   T1: 20 stone + 5 wood                    // Lighthouse placeholder — tune in Appendix A
  //   T2: 50 stone + 10 steel + 2 glass_panel  // Lighthouse placeholder — tune in Appendix A
  //   T3: 100 steel + 20 microchip             // Lighthouse placeholder — tune in Appendix A
  //   T4: 200 steel + 50 microchip + 10 fiber_optic   // Lighthouse placeholder — tune in Appendix A
  //   T5: 500 reality_anchor + T5 components   // Lighthouse placeholder — tune in Appendix A
  //   T6: 1000 antimatter-tier components,     // Lighthouse placeholder — tune in Appendix A
  //       ascendant-gated.
  //
  // No recipes (passive vision beacons). T1 is zero-power; T2-T6 consume
  // increasing power so each tier carries an upkeep.
  lighthouse_t1: {
    id: 'lighthouse_t1',
    displayName: 'Lighthouse T1',
    category: 'special',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xd4c898, // pale sand
    stroke: 0x484028,
    // Zero-power signal beacon. No `power` declaration so the economy
    // skips it on both produce and consume sides.
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { stone: 20, wood: 5 },
    glyph: '⛯',
  },
  lighthouse_t2: {
    id: 'lighthouse_t2',
    displayName: 'Lighthouse T2',
    category: 'special',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0xd0d0d0, // weathered concrete
    stroke: 0x404040,
    power: { consumes: 10 },
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { stone: 50, iron_ingot: 10, glass: 2 },
    glyph: '⛯',
  },
  lighthouse_t3: {
    id: 'lighthouse_t3',
    displayName: 'Lighthouse T3',
    category: 'special',
    tier: 3,
    footprint: SHAPES.single,
    fill: 0xb0c8e0, // pale steel
    stroke: 0x304058,
    power: { consumes: 25 },
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { steel: 100, microchip: 20 },
    glyph: '⛯',
  },
  lighthouse_t4: {
    id: 'lighthouse_t4',
    displayName: 'Lighthouse T4',
    category: 'special',
    tier: 4,
    footprint: SHAPES.single,
    fill: 0x90b8d0, // sky-instrument
    stroke: 0x203040,
    power: { consumes: 60 },
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { steel: 200, microchip: 50, glass: 10 },
    glyph: '⛯',
  },
  lighthouse_t5: {
    id: 'lighthouse_t5',
    displayName: 'Lighthouse T5',
    category: 'special',
    tier: 5,
    footprint: SHAPES.single,
    fill: 0xc080e0, // transcendent violet
    stroke: 0x400060,
    power: { consumes: 150 },
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 30, steel: 50, microchip: 25 },
    glyph: '⛯',
  },
  lighthouse_t6: {
    id: 'lighthouse_t6',
    displayName: 'Lighthouse T6',
    category: 'special',
    tier: 6,
    footprint: SHAPES.single,
    fill: 0xe0c060, // ascendant gold
    stroke: 0x504010,
    power: { consumes: 400 },
    // Lighthouse placeholder — tune in Appendix A.
    placementCost: { antimatter_propellant: 30, steel: 50, reality_anchor: 30 },
    glyph: '⛯',
  },
  // -------------------------------------------------------------------------
  // §11 telemetry — Antenna family. Six tiers extending the drone-scan
  // relay range. Signal radius (in tiles) lives in `antenna.ts →
  // ANTENNA_SIGNAL_RADII`; the economy doesn't read it. Build costs are
  // deferred to Appendix A.
  //
  //   T1: 1×1, radius 80,  zero-power (basic signal beacon)
  //   T2: 1×1, radius 140, 5 W
  //   T3: 1×1, radius 220, 25 W
  //   T4: 2×2, radius 320, 60 W (comm tower)
  //   T5: 2×2, radius 480, 150 W (exotic signal)
  //   T6: 2×2, radius 700, 400 W (doubles as satellite dish — §14 dish dual-role DEFERRED)
  //
  // Antenna placeholder — tune in Appendix A.
  antenna_t1: {
    id: 'antenna_t1',
    displayName: 'Antenna T1',
    category: 'special',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0xa0b0c0, // pale telemetry blue
    stroke: 0x303848,
    // Zero-power basic beacon. Antenna placeholder — tune in Appendix A.
    placementCost: { stone: 15, wood: 5 },
    glyph: '⟁',
  },
  antenna_t2: {
    id: 'antenna_t2',
    displayName: 'Antenna T2',
    category: 'special',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x80a0c0,
    stroke: 0x203048,
    // Antenna placeholder — tune in Appendix A.
    power: { consumes: 5 },
    placementCost: { stone: 50, iron_ingot: 15 },
    glyph: '⟁',
  },
  antenna_t3: {
    id: 'antenna_t3',
    displayName: 'Antenna T3',
    category: 'special',
    tier: 3,
    footprint: SHAPES.single,
    fill: 0x6088c0,
    stroke: 0x102038,
    // Antenna placeholder — tune in Appendix A.
    power: { consumes: 25 },
    placementCost: { steel: 100, microchip: 25 },
    glyph: '⟁',
  },
  antenna_t4: {
    id: 'antenna_t4',
    displayName: 'Comm Tower (Antenna T4)',
    category: 'special',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x4878c0,
    stroke: 0x081830,
    // Antenna placeholder — tune in Appendix A.
    power: { consumes: 60 },
    placementCost: { steel: 250, microchip: 80, glass: 20 },
    glyph: '⟁',
  },
  antenna_t5: {
    id: 'antenna_t5',
    displayName: 'Exotic Antenna (Antenna T5)',
    category: 'special',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x9070c0, // exotic violet
    stroke: 0x301050,
    // Antenna placeholder — tune in Appendix A.
    power: { consumes: 150 },
    placementCost: { reality_anchor: 40, steel: 80, microchip: 40 },
    glyph: '⟁',
  },
  antenna_t6: {
    id: 'antenna_t6',
    displayName: 'Ascendant Antenna (Antenna T6)',
    category: 'special',
    tier: 6,
    footprint: SHAPES.square2,
    fill: 0xd8b840, // ascendant gold + antenna-blue blend
    stroke: 0x483820,
    // Antenna placeholder — tune in Appendix A. T6 antenna ALSO acts as the
    // satellite dish for §14 orbital launches (dish dual-role DEFERRED).
    power: { consumes: 400 },
    placementCost: { antimatter_propellant: 40, steel: 80, reality_anchor: 40 },
    glyph: '⟁',
  },
  // ---------------------------------------------------------------------------
  // T3 microchip intermediate chain (§7.7)
  // ---------------------------------------------------------------------------
  pcb_etcher: {
    id: 'pcb_etcher',
    displayName: 'PCB Etcher',
    category: 'electronics',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x4a7a5a,
    stroke: 0x1a3a2a,
    power: { consumes: 80 },
    placementCost: { steel: 50, microchip: 20, stone: 20 },
    glyph: '◈',
  },
  circuit_assembler: {
    id: 'circuit_assembler',
    displayName: 'Circuit Assembler',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x4a90d9,
    stroke: 0x2a6099,
    power: { consumes: 30 },
    placementCost: { steel: 10, microchip: 5, gear: 5 },
    glyph: '◈',
  },
  processor_fab: {
    id: 'processor_fab',
    displayName: 'Processor Fabricator',
    category: 'electronics',
    tier: 4,
    footprint: SHAPES.rect3x2,
    fill: 0x6a50b9,
    stroke: 0x4a3099,
    power: { consumes: 60 },
    placementCost: { steel: 20, microchip: 10, exotic_alloy: 2 },
    glyph: '◈',
  },
  compute_module_fab: {
    id: 'compute_module_fab',
    displayName: 'Computing Module Fabricator',
    category: 'electronics',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x8a40a9,
    stroke: 0x6a2089,
    power: { consumes: 100 },
    placementCost: { steel: 30, quantum_chip: 2, exotic_alloy: 5 },
    glyph: '◈',
  },
  // -------------------------------------------------------------------------
  // §2.6 weather stations
  // -------------------------------------------------------------------------
  weather_station_t2: {
    id: 'weather_station_t2',
    displayName: 'Weather Station',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x6090c0,
    stroke: 0x203050,
    power: { consumes: 10 },
    placementCost: { steel: 5, gear: 2, glass: 5 },
    glyph: '☁',
  },
  advanced_weather_station_t3: {
    id: 'advanced_weather_station_t3',
    displayName: 'Advanced Weather Station',
    category: 'special',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x4070a0,
    stroke: 0x102040,
    power: { consumes: 25 },
    placementCost: { steel: 10, microchip: 2, glass: 10 },
    glyph: '☁',
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
 *  the caller explicitly opts in by passing `state.aiCoreCrafted`.
 *
 *  Step-20: T6 defs require both `ascendantCoreCrafted` (§14.1 first half)
 *  AND a placed Spaceport on the island (§14.1 second half). Spaceport
 *  itself is EXEMPT from the spaceport-placed half (otherwise it'd be
 *  unbuildable by definition — a §14.1 chicken-and-egg); it gates on
 *  `ascendantCoreCrafted` alone. Both new parameters default to false so
 *  pre-step-20 callers continue to see T6 rows locked. */
export function buildingUnlocked(
  islandLevel: number,
  defId: BuildingDefId,
  aiCoreCrafted: boolean = false,
  ascendantCoreCrafted: boolean = false,
  hasSpaceport: boolean = false,
): boolean {
  const def = BUILDING_DEFS[defId];
  if (def.tier === 6) {
    // §14.1 chicken-and-egg resolution: Spaceport itself is the gate
    // building, so it cannot itself require a Spaceport-already-placed.
    // The remaining T6 defs need both halves of the §14.1 gate.
    if (defId === 'spaceport') return ascendantCoreCrafted;
    return ascendantCoreCrafted && hasSpaceport;
  }
  if (def.tier === 5) return islandLevel >= 50 && aiCoreCrafted;
  return tierForLevel(islandLevel) >= def.tier;
}

/** Every def unlocked at the given island level, in catalog declaration order.
 *  Step-13: T5 defs are EXCLUDED from this list unless `aiCoreCrafted` is
 *  also true (defaults to false to keep tier-only callers unaffected).
 *  Step-20: T6 defs are EXCLUDED unless both `ascendantCoreCrafted` and
 *  `hasSpaceport` are true (Spaceport itself is exempt from the latter —
 *  see `buildingUnlocked`). */
export function unlockedDefs(
  islandLevel: number,
  aiCoreCrafted: boolean = false,
  ascendantCoreCrafted: boolean = false,
  hasSpaceport: boolean = false,
): BuildingDefId[] {
  return (Object.keys(BUILDING_DEFS) as BuildingDefId[]).filter((id) =>
    buildingUnlocked(islandLevel, id, aiCoreCrafted, ascendantCoreCrafted, hasSpaceport),
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
