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
// Universe Editor, Lattice Node. §13.3 mechanics are live: time banking
// (`spendTimeLock` in economy.ts), free creation (`genesis_chamber` in
// economy.ts:542-598 / 792-804), biome reassignment (`editIslandBiome` in
// world.ts), network unity (`latticeActive`), and Probability Engine drone
// scan bias. The T5 access gate (§13.1) — level ≥ 50 AND `aiCoreCrafted`
// flag — is enforced in `buildingUnlocked` below, not by the tier-only
// `tierForLevel`. The Casimir Tap power figure is a placeholder; full §8.10
// T5 raw extractors (Aetheric Conduit, Spacetime Resonator, Eldritch Sieve)
// and their multi-hour cycle times shipped in step 18 for Aetheric Conduit /
// Spacetime Resonator / Eldritch Sieve; Casimir Tap cycle remains placeholder
// (1800s).
//
// §13.2 deliberate substitution: spec §13.2 lists Probability Engine in the
// T5 building set; step 13 shipped Time Lock instead because Time Lock has
// richer §13.3 behavioural detail (banking + spending semantics) which made
// its placeholder more meaningful as documentation. Probability Engine
// (drone rare-encounter scan bias) shipped subsequently and is wired through
// `drones.ts` for scan bias.
//
// Heat-source adjacency (§5.2) IS implemented. The economy passes consumer
// recipes through `resolveHeatAssignments` (heat.ts) before rate computation:
// a `requiresHeat` building with no adjacent Heat Source has its effective
// rate forced to 0 and contributes 0 to P_consumed. Coal-burning sources
// (Coal Furnace) burn `coalPerCycle × consumersServed` coal per cycle; free
// sources (Geothermal Vent / Plasma Heater / Fusion Core) cost no fuel.
// T4 omnidirectional pulse mechanic (§11.5) for the Launch Tower is live
// via `firePulse` (3-cell-radius single-disk reveal).
//
// No PixiJS imports, no DOM — `building-defs.ts` is pure data + the tier
// gate + biome gate. `buildings.ts` consumes BUILDING_DEFS for rendering;
// `recipes.ts` keys its RECIPES table by `BuildingDefId`.

import type { TerrainKind } from './island.js';
import type { OceanTerrain } from './ocean-cell.js';
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
  | 'production'
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
  // Task 13.2 — Foundation Kit Enriched (T3) + Refined (T4) variants.
  | 'kit_assembler_enriched'
  | 'kit_assembler_refined'
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
  | 'steel_mill_scrap'
  | 'oxygen_converter'
  | 'slag_reprocessor'
  | 'assembler'
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
  | 'quantum_manipulator'
  | 'quantum_chip_fab'
  | 'fuel_rod_assembler'
  // Phase 11 — T4 endgame (Task 11.4)
  | 'plasma_containment_assembler'
  | 'singularity_sensor_lab'
  | 'cryo_containment_assembler'
  | 'accelerator_core_lab'
  | 'self_replication_lab'
  // §04: Skill Forge — T4 production building for crafting Skill Crystals.
  | 'skill_forge'
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
  // Phase 12 — T5 transcendent raws (Task 12.1)
  | 'zero_point_extractor'
  | 'neutronium_extractor'
  // Phase 12 — T5 component labs (Task 12.2)
  | 'probability_calculator_lab'
  | 'dimensional_fold_lab'
  | 'causal_regulator_lab'
  // Phase 12 — T5 component labs (Task 12.3)
  | 'tachyonic_transmitter_lab'
  | 'aether_beacon_lab'
  | 'reality_engine_lab'
  | 'singularity_battery_factory'
  // T5→T6 transition (step 20): produces `ascendant_core`, the §14.1 gate
  // artifact. Built at T5 (level 50 + AI core) so the player can craft
  // ascendant_core BEFORE the §14.1 Spaceport requirement — Ascendant
  // Core is per §13.4 a T5 endgame artifact whose existence promotes the
  // island into the T6 access band.
  | 'ascendant_assembly'
  // §13.4 Genesis Cell producer — T5 manufacturing. Recipe per §13.4
  // literal: 4 reality_anchor + 1 zero_point_flux + 2 causal_regulator
  // + 1 memetic_core, 24h cycle → 1 genesis_cell. NOT a victory artifact
  // (spec is explicit: no win screen, game continues indefinitely).
  | 'genesis_forge'
  // T6 (§14 / step 20) defs. The §14.2-14.8 / §14.12 live mechanics —
  // Spaceport tier I/II/III upgrade lifecycle, satellite launches and
  // variants, comm graph, dwell ramps, maneuvering fuel, launch success,
  // debris and Kessler cascades, §14.9 Orbital skill sub-paths, and §14.12
  // Repair Drone operations — are all wired through `orbital.ts`.
  | 'spaceport'
  | 'orbital_tracking_station'
  | 'antimatter_refinery'
  | 'scanner_sat_assembly'
  | 'relay_sat_assembly'
  | 'sweeper_sat_assembly'
  | 'mirror_sat_assembly'
  | 'oip_assembly'
  | 'repair_pack_assembly'
  | 'repair_drone_assembly'
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
  | 'copper_mine'
  | 'tin_mine'
  | 'lead_mine'
  | 'bauxite_mine'
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  | 'limekiln'
  | 'lime_slaker'
  | 'brick_kiln'
  | 'mortar_mixer'
  | 'cement_mill'
  | 'concrete_plant'
  | 'charcoal_kiln'
  | 'plank_mill'
  | 'copper_smelter'
  | 'tin_smelter'
  | 'lead_smelter'
  | 'solder_alloyer'
  // Phase 7 — Bronze + Brass (§7.2)
  | 'bronze_alloyer'
  | 'brass_alloyer'
  // Phase 8 — Aluminum chain (§7.3)
  | 'alumina_refinery'
  | 'aluminum_smelter'
  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  | 'manganese_mine'
  | 'manganese_smelter'
  | 'carbon_steel_mill'
  | 'zinc_mine'
  | 'zinc_smelter'
  | 'galvanizing_bath'
  | 'chromium_mine'
  | 'chromium_smelter'
  | 'nickel_mine'
  | 'nickel_smelter'
  | 'stainless_steel_mill'
  | 'tungsten_mine'
  | 'tungsten_smelter'
  | 'tool_steel_mill'
  | 'lumber_mill'
  | 'glassworks'
  | 'evaporator'
  | 'electrolyzer'
  | 'biofuel_plant'
  | 'pump_jack'
  | 'gas_extractor'
  | 'naphtha_cracker'
  | 'crude_oil_cracker'
  | 'plastic_polymerizer_a'
  | 'rigid_plastic_press'
  | 'flexible_plastic_press'
  | 'rubber_synthesizer'
  | 'sulfuric_acid_plant'
  | 'hcl_plant'
  | 'phosphor_plant'
  | 'chlor_alkali_plant'
  | 'chemical_reactor'
  | 'lubricant_refinery'
  | 'diesel_refinery'
  | 'metal_rolling_mill'
  // §15.6 saltwater-cell bootstrap — T1 manufacturing slot for saltwater_cell.
  | 'cell_press'
  | 'sheet_metal_mill'
  | 'pipe_mill'
  | 'beam_mill'
  | 'bearing_assembler'
  | 'spring_press'
  | 'cable_mill'
  | 'battery_factory'
  | 'glass_panel_press'
  | 'coolant_synthesizer'
  | 'ceramic_kiln'
  | 'silicon_crusher'
  | 'air_separator'
  | 'cryo_air_separator'
  | 'cryo_lab'
  | 'cryo_compressor'
  | 'kerosene_refinery'
  | 'lithography_lab'
  | 'wafer_lab'
  | 'transistor_doping'
  | 'capacitor_doping'
  | 'resistor_doping'
  | 'memory_lab'
  | 'drilling_rig'
  | 'aetheric_conduit'
  | 'spacetime_resonator'
  | 'eldritch_sieve'
  | 'plasma_forge'
  | 'eldritch_refiner'
  | 'phase_refiner'
  // Phase 10 — T3 minerals + alloy (Task 10.1)
  | 'mercury_well'
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  | 'diamond_quarry'
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  | 'cryo_compound_lab'
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  | 'mag_alloyer'
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  | 'lithium_extractor'
  // Phase 16.1 — §6.4 uranium extractor (Task 16.1)
  | 'uranium_mine'
  // Phase 16.2 — §6.6 memetic_core producer (Task 16.2)
  | 'memetic_forge'
  // Phase 10b — T3 power components (Task 10.5)
  | 'mag_forge'
  // Phase 10b — T3 power components (Task 10.6)
  | 'motor_assembly'
  // Phase 10b — T3 power components (Task 10.7)
  | 'generator_lab'
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  | 'pump_assembly'
  | 'hydraulic_assembly'
  | 'pneumatic_assembly'
  // Phase 10c — T3 power components (Task 10.9)
  | 'solar_cell_lab'
  // Phase 10c — T3 power components (Task 10.10)
  | 'fuel_cell_lab'
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  | 'optical_glass_kiln'
  // Phase 10c — T3 fiber spinners (Task 10.12)
  | 'glass_fiber_spinner'
  | 'optical_fiber_drawer'
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
  // STILL-DEFERRED). Costs are placeholders — Antenna placeholder — tune in
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
  | 'water_wheel'
  | 'wind_turbine'
  | 'windmill_t0'
  | 'battery_bank'
  | 'bulk_concrete_plant'
  | 'capacitor_bank'
  | 'cryogenic_generator'
  | 'flywheel_array'
  | 'newcomen_engine'
  | 'nuclear_reactor'
  // §8.7 cooling / treatment
  | 'cooling_tower'
  | 'wastewater_treatment'
  | 'exhaust_scrubber'
  | 'airship_dock'
  | 'teleporter_pad'
  | 'spacetime_anchor'
  | 'power_substation'
  | 'terrain_modifier'
  // Ocean-layer §5 — T2 active depth-discovery building. Placed on any
  // ocean cell adjacent to a populated anchor island; while powered, marks
  // every cell within SONAR_BUOY_RADIUS_TILES in both `revealedCells` and
  // `depthRevealedCells`. The `oceanPlacement` / `terrainReqs` flags on
  // this def are declared but NOT yet enforced — Task 8 wires placement.
  | 'sonar_buoy'
  // Ocean-layer §3 — Task 8 extractor catalog. Each is ocean-placed via
  // `validateOceanPlacement` (placement.ts) against `world.oceanCells` —
  // 2×2 cell footprints under a specific terrain rule per the §3 table.
  // UI wiring of the anchor picker (placement-ui.ts → mountAnchorPicker)
  // is deferred to a follow-up; the defs + recipes + data-layer validation
  // ship here so chain producers exist for §3 processors (Task 9).
  | 'seawater_intake_rig'
  | 'open_water_extractor'
  | 'nodule_harvester'
  | 'trench_drill'
  | 'vent_tap'
  // Ocean-layer §3 — Task 9 processor catalog. 4 chemistry processors + 1
  // passive power source. All ocean-placed; processors accept shallows OR
  // deep, Geothermal Vent Generator requires hydrothermal_vent (a rare
  // terrain — gated by §2 terrain rarity). The processors consume Task 8
  // raws and the existing chemistry/exotic chains to produce T3-T5
  // intermediates and finals (lithium_brine, salt, bromine,
  // rare_earth_concentrate, refined_cobalt, exotic_alloy_seed, tritium_seed,
  // heavy_water). Geothermal Vent Generator has NO recipe — it's a passive
  // 2 kW producer (cf. solar_panel / nuclear_reactor / fusion_core), wired
  // into the §5.1 power balance through def.power.produces alone.
  | 'brine_distillation_rig'
  | 'nodule_concentrator'
  | 'vent_mineral_refinery'
  | 'heavy_water_distiller'
  | 'geothermal_vent_generator';

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
   *  applies to the production side; consumers ignore the flag.
   *  `kind: 'wind'` marks the producer as wind-driven — its `produces`
   *  output is multiplied by `ModifierMultipliers.windPowerMul`
   *  (1.5× on `high_wind` islands per §3.5, 1.0× otherwise). Single
   *  literal for now; generalises to `'wind' | 'solar' | …` later
   *  (`solar` keeps its existing boolean flag for back-compat with the
   *  §2.7 day-night multiplier wire). */
  readonly power?: {
    readonly produces?: number;
    readonly consumes?: number;
    readonly solar?: boolean;
    readonly kind?: 'wind';
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
    /** Thermal output in kW per rev-16 §5.3. Phase 3 reads this to
     *  throttle consumers proportionally when supply < demand.
     *  Phase 1 declares only. */
    readonly thermalKW?: number;
  };
  /** §5.2 heat-consumer declaration. When `true`, the building requires at
   *  least one adjacent Heat Source in its 4-neighbor footprint border to
   *  operate. Without heat, the economy zeroes its effective rate and skips
   *  its power-consumption contribution (§5.1 inactive). Currently set on
   *  Coke Oven, Blast Furnace, Electric Arc Furnace, and Pyroforge. NOT
   *  set on the T1 Smelter — the basic smelter remains the bootstrap
   *  unconditional iron→ingot link (a Smelter without heat is intentional). */
  readonly requiresHeat?: boolean;
  /** Heat demand in kW — Phase 3 of the SI-units rework wires the
   *  proportional-throttle consumer side per rev-16 §5.1. Phase 1
   *  declares only. */
  readonly heatDemandKW?: number;
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
  /** Ocean-layer §4 / §5 — when `true`, this building is placed on an OCEAN
   *  cell (anchored to a player-picked populated island), not on a tile of
   *  some island's footprint. Declared here so the placement pipeline can
   *  branch on a single boolean; **NOT YET ENFORCED** — Task 8 wires the
   *  `placement.ts` / `placement-ui.ts` integration that consults this flag
   *  plus `terrainReqs` against `world.oceanCells`. For Task 6 (Sonar Buoy
   *  scaffolding) the flag is declared on the def for forward compat and
   *  ignored by the existing land-only placement path. */
  readonly oceanPlacement?: boolean;
  /** Ocean-layer §4 / §5 — when `oceanPlacement === true`, the list of
   *  acceptable `OceanTerrain` values under the building's footprint. Empty
   *  / undefined ⇒ no terrain restriction (placement allowed on any ocean
   *  cell). Enforcement deferred to Task 8 (see `oceanPlacement` above). */
  readonly terrainReqs?: ReadonlyArray<OceanTerrain>;
  /** terrain_modifier v5 — opt-in flag for the 16-tile brush placement preview
   *  + the terrain-modifier-target-picker pre-placement modal. Defs with this
   *  flag must declare a 2×2 footprint (SHAPES.square2); placement-ui (Task 3)
   *  reads the flag to decide whether to paint the brush preview vs. the bare
   *  footprint outline. Optional / undefined ≡ false for every other def. */
  readonly terrainModifier?: boolean;
  /** When `true`, the building skips construction and is operational
   *  immediately on placement. Used by terrain_modifier (v5 spec lock
   *  `modifier_never_enters_construction`) so the shot timer starts at
   *  placement instead of after a 2-minute build. Optional / undefined ≡ false. */
  readonly instantBuild?: boolean;
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
    power: { consumes: 25 }, // 2026-05-23 coal loop rebalance — also applies to mine_on_ore via shared def.
    requiredTile: ['ore', 'coal'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small open-pit head-frame analog: 200 kg foundation stone + 80 kg wood
    // frame = 280 kg embodied.
    // cycle-break (P4C2b): removed iron_ingot per circular-deps invariant.
    placementCost: { stone: 200, wood: 80 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12 — deep-shaft head-frame.
    // 12000 concrete + 8000 stone + 3000 iron_ingot + 500 gear + 2000 clay = 26.0 t.
    placementCost: { concrete: 12000, stone: 8000, iron_ingot: 3000, gear: 500, clay: 2000 },
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
    // BOM source: Roberts Light-Engineering Workshop.
    // 150 wood framing + 100 stone foundation + 30 iron fixtures = 280 kg.
    // cycle-break (P4C2b): removed bolt per circular-deps invariant.
    placementCost: { wood: 150, stone: 100, iron_ingot: 30 },
    glyph: '⚙',
    // §4.5 placeholder — tune in Appendix A. Manufacturing co-location bonus:
    // small per-match rate boost up to three adjacent Workshops.
    adjacencyBuffs: [
      { matchKind: 'same_def', percentPerMatch: 5, maxMatches: 3 },
    ],
  },
  // §15.6 saltwater-cell bootstrap — T1 manufacturing slot, single tile, 20W draw.
  // Crafts saltwater_cell (T2 component) from saltwater + iron_ingot + wire.
  // No requiredTile, no requiresHeat — placeable anywhere on grass.
  cell_press: {
    id: 'cell_press',
    displayName: 'Cell Press',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x80a0c0,       // pale electrolyte blue
    stroke: 0x203040,
    power: { consumes: 20 },
    // BOM source: Daniell-cell + lab-press analog.
    // 10 copper electrodes + 2 iron frame + 5 saltwater electrolyte + 1 wood base = ~18 kg.
    placementCost: { copper_ingot: 10, iron_ingot: 2, saltwater: 5, wood: 1 },
    glyph: '◫',
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
    // BOM source: NREL TP-6A20-72443 Residential PV BOM.
    // 1 m² c-Si PV: 6 silicon + 2 glass + 1 aluminum + 1 wire + 1 backsheet = ~10 kg.
    placementCost: { silicon: 6, glass: 2, aluminum: 1, wire: 1, plastic_precursor: 1 },
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
    // BOM source: Babcock & Wilcox, *Steam* 41e ch. 25.
    // Small coal-fired steam generator: 500 steel_beam + 200 clay fire-brick + 100 stone
    // foundation + 50 pipe + 10 microchip control = ~1000 kg.
    placementCost: { steel_beam: 500, clay: 200, stone: 100, pipe: 50, microchip: 10 },
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
    // BOM source: Vernacular civil engineering — timber pile dock.
    // 150 kg stone ballast + 100 kg wood deck + 30 kg iron fasteners = 280 kg.
    placementCost: { stone: 150, wood: 100, iron_ingot: 30 },
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
    // BOM source: DOT heliport design guide — small UAS landing pad.
    // 2000 concrete + 1000 stone + 500 iron_ingot + 100 gear = 3.7 t.
    placementCost: { concrete: 2000, stone: 1000, iron_ingot: 500, gear: 100 },
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
    // BOM source: Roberts, *Engineering Workshop* — logging camp gantry.
    // 30 kg stone foundation + 30 kg wood frame + 10 kg iron saw = 70 kg.
    placementCost: { stone: 30, wood: 30, iron_ingot: 10 },
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
    power: { consumes: 40 },
    requiredTile: ['tree'],
    // BOM source: Roberts, *Engineering Workshop* — logging camp heavy gantry.
    // 8000 concrete + 5000 stone + 2000 iron_ingot + 300 gear + 200 copper_ingot = 15.8 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2000, gear: 300, copper_ingot: 200 },
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
    // BOM source: Small Bealer bloomery analog.
    // 400 stone foundation + 100 clay fire-brick + 20 wood fuel = 520 kg.
    // cycle-break (P4C2b): removed iron_ingot per circular-deps invariant.
    placementCost: { stone: 400, clay: 100, wood: 20 },
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
    // rev-16 §13.3: +500 cap on ONE player-chosen resource per instance.
    // Pallet-rack section analog. Generic storage — each PlacedBuilding picks
    // its `cargoLabel` and only that resource's cap is raised.
    storage: { category: 'generic', capacity: 500 },
    // §14 placeholder — tune in Appendix A.
    // BOM source: WarehouseRack.com pallet-rack section.
    // 15 kg stone foundation + 35 kg wood slats = 50 kg.
    placementCost: { stone: 15, wood: 35 },
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
    // rev-16 §13.3: +200000 cap (200 t), dry-goods category only.
    // Coban Machinery 50 t farm silo × 4 modules analog. Bumps every resource
    // whose RESOURCE_STORAGE_CATEGORY === 'dry_goods'.
    storage: { category: 'dry_goods', capacity: 200000 },
    // §14 placeholder — tune in Appendix A.
    // BOM source: Coban Machinery small farm silo.
    // 150 kg stone pad + 60 kg wood framing + 40 kg iron fasteners = 250 kg.
    placementCost: { stone: 150, wood: 60, iron_ingot: 40 },
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
    // BOM source: USDA ARS biomass-boiler reference.
    // 400 steel_beam boiler + 150 clay fire-brick + 100 stone pad + 30 pipe + 80 wood fuel = ~850 kg.
    placementCost: { steel_beam: 400, clay: 150, stone: 100, pipe: 30, wood: 80 },
    glyph: '❀',
  },
  // rev-16 §10.15-A — bootstrap power, no fuel, shoreline only.
  // BOM source: rev-16 §4.3 + 19th-c. overshot watermill analog.
  // 50 wood frame + 30 stone foundation + 5 iron axle = 85 kg.
  water_wheel: {
    id: 'water_wheel',
    displayName: 'Water Wheel',
    category: 'power',
    // Intended tier: 0 — using 1 because type system only supports 1-6 currently.
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x6a5b3e,
    stroke: 0x2a1e08,
    power: { produces: 20 },
    // 'water_edge' is not in TerrainKind; 'water' is the existing shoreline kind.
    requiredTile: ['water'],
    placementCost: { wood: 50, stone: 30, iron_ingot: 5 },
    glyph: '⌬',
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
    power: { produces: 40, kind: 'wind' },
    requiredTile: ['water'],
    // BOM source: NREL ATB-2024 land-based wind.
    // 800 steel_beam tower + 50 aluminum nacelle + 200 stone foundation + 5 magnet + 30 wire = 1315 kg.
    placementCost: { steel_beam: 800, aluminum: 50, stone: 200, magnet: 5, wire: 30 },
    glyph: '✦',
  },
  // rev-16 §10.15-A — bootstrap power, no fuel, open-air grass.
  // BOM source: rev-16 §4.3 + Dutch tjasker analog (wooden sail-mill).
  // 80 wood + 20 stone + 3 iron = 103 kg.
  windmill_t0: {
    id: 'windmill_t0',
    displayName: 'Windmill (T0)',
    category: 'power',
    // Intended tier: 0 — using 1 because type system only supports 1-6 currently.
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x9aa07a,
    stroke: 0x4a4830,
    power: { produces: 15 },
    requiredTile: ['grass'],
    placementCost: { wood: 80, stone: 20, iron_ingot: 3 },
    glyph: '※',
  },
  // §8.5 T2 battery — 5 kWh power buffer. Zero standby; charges from
  // any island power surplus, discharges into deficit. Capacity is set
  // via the BATTERY_CAPACITY_WS table in economy.ts (Task 4).
  battery_bank: {
    id: 'battery_bank',
    displayName: 'Battery Bank',
    category: 'power',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x4060a0, // slate blue
    stroke: 0x101030,
    power: { consumes: 0 },
    // BOM source: Trojan T-105 lead-acid stack.
    // 20 saltwater_cell + 15 wire + 5 steel_beam rack + 30 lead_ingot plates = 340 kg.
    placementCost: { saltwater_cell: 20, wire: 15, steel_beam: 5, lead_ingot: 30 },
    glyph: '▭',
  },
  // §8.5 T3 capacitor bank — 100 kWh power buffer. Zero standby; charges
  // from any island power surplus, discharges into deficit.
  capacitor_bank: {
    id: 'capacitor_bank',
    displayName: 'Capacitor Bank',
    category: 'power',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x6080d0, // bright cobalt
    stroke: 0x202050,
    power: { consumes: 0 },
    // BOM source: ABB MV Capacitor Banks catalog.
    // 100 capacitor + 50 microchip + 30 steel_beam rack + 20 wire + 10 coolant = 1625 kg.
    placementCost: { capacitor: 100, microchip: 50, steel_beam: 30, wire: 20, coolant: 10 },
    glyph: '▥',
  },
  // §8.5 T4 flywheel array — 2 MWh power buffer. Zero standby; same
  // charge/discharge wiring as the smaller battery_bank / capacitor_bank.
  flywheel_array: {
    id: 'flywheel_array',
    displayName: 'Flywheel Array',
    category: 'power',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0xa0b0c0, // brushed steel
    stroke: 0x303040,
    power: { consumes: 0 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { battery: 100, microchip: 40, steel_beam: 20, coolant: 10, heavy_cable: 5 },
    glyph: '◯',
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
    // rev-16 §5.3: 1 coal × 25 MJ/kg / 30 s = 833 kW (bituminous HHV).
    heatSource: { freeOrCoal: 'coal', coalPerCycle: 1, thermalKW: 830 },
    // §14 placeholder — tune in Appendix A.
    // BOM source: Roberts, *Engineering Workshop* — small cast-iron stove.
    // 50 kg stone hearth + 20 kg iron firebox + 30 kg wood fuel rack = 100 kg.
    placementCost: { stone: 50, iron_ingot: 20, wood: 30 },
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
    // rev-16 §5.3: 1 MW typical low-grade geothermal well (IRENA).
    heatSource: { freeOrCoal: 'free', thermalKW: 1000 },
    // §14 placeholder — tune in Appendix A.
    // BOM source: IRENA low-grade geothermal wellhead reference.
    // 200 kg stone pad + 80 kg iron pipe + 30 kg wood shelter = 310 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30 },
    glyph: '♨',
  },
  // rev-16 §12.5 Bonus — pre-electric thermal power, burns coal/charcoal.
  // BOM source: rev-16 §4.3 + Smeaton's 1772 cylinder-pump-beam reconstruction.
  // 200 stone foundation + 80 iron beam + 40 copper boiler + 30 wood scaffolding + 5 bolt = 355 kg.
  newcomen_engine: {
    id: 'newcomen_engine',
    displayName: 'Newcomen Engine',
    category: 'power',
    tier: 1,
    footprint: SHAPES.single,
    fill: 0x806040,
    stroke: 0x301808,
    power: { produces: 4 },
    placementCost: { stone: 200, iron_ingot: 80, copper_ingot: 40, wood: 30, bolt: 5 },
    glyph: '⚒',
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
    // BOM source: Roberts, *Engineering Workshop* — light assembly bench.
    // 150 kg stone pad + 60 kg wood bench + 40 kg iron fixtures + 10 kg bolt hardware = 260 kg.
    placementCost: { stone: 150, wood: 60, iron_ingot: 40, bolt: 200 },
    glyph: '⚙',
  },
  // §12.3: Kit Assembler Enriched — T3 variant producing Foundation Kit Enriched.
  kit_assembler_enriched: {
    id: 'kit_assembler_enriched',
    displayName: 'Kit Assembler Enriched',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xa0a060,
    stroke: 0x4a3520,
    power: { consumes: 150 },
    placementCost: { steel: 80, microchip: 5 },
    glyph: '⚙',
  },
  // §12.3: Kit Assembler Refined — T4 variant producing Foundation Kit Refined.
  kit_assembler_refined: {
    id: 'kit_assembler_refined',
    displayName: 'Kit Assembler Refined',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0xc0a080,
    stroke: 0x4a3520,
    power: { consumes: 300 },
    placementCost: { steel: 150, microchip: 20, glass: 10 },
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
    // BOM source: Vernacular civil engineering — small boat slip.
    // 400 kg stone slip + 250 kg wood cradle + 100 kg iron fittings = 750 kg.
    placementCost: { stone: 400, wood: 250, iron_ingot: 100 },
    coastal: true,
    glyph: '⚓',
  },
  // §8.8 / §12.2: Helipad — T1 logistics building that launches §12
  // helicopters for settlement. Faster than ships, no coastal requirement.
  helipad: {
    id: 'helipad',
    displayName: 'Helipad',
    category: 'logistics',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x6a8a9a,
    stroke: 0x1f3340,
    power: { consumes: 60 },
    // §14 placeholder — tune in Appendix A.
    // BOM source: DOT heliport design guide (scaled T1 landing circle).
    // 200 kg stone base + 60 kg wood marker frame + 60 kg iron tie-downs = 320 kg.
    placementCost: { stone: 200, wood: 60, iron_ingot: 60 },
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
    // BOM source: spec-mandate: no real analog.
    // 1500 steel_beam platform + 200 microchip + 100 wire + 50 exotic_alloy + 20 reality_anchor = 1.64 t.
    placementCost: { steel_beam: 1500, microchip: 200, wire: 100, exotic_alloy: 50, reality_anchor: 20 },
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
    // rev-16 §5.3: single-chamber 1100 °C carbonization (IspatGuru).
    heatDemandKW: 60,
    // §4.5 gating adjacency: hard heat_source gate, plus §8.7 soft
    // exhaust-scrubber gate — this is one of the spec's "high-emission"
    // buildings, so missing an adjacent Exhaust Scrubber drops output to
    // 50% (still produces, but unclean operation costs throughput).
    gates: [
      { matchType: 'heat_source', hard: true },
      { matchType: 'def_id', defId: 'exhaust_scrubber', degradeMul: 0.5 },
    ],
    // BOM source: IspatGuru "Coke Ovens".
    // 15000 clay refractory + 500 stone foundation + 100 pipe = 15.6 t.
    // cycle-break (P4C2b): removed steel_beam per circular-deps invariant.
    placementCost: { clay: 15000, stone: 500, pipe: 100 },
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
    // rev-16 §5.3: 2×2 hot-blast preheat 1000-1300 °C (IspatGuru).
    heatDemandKW: 3000,
    // §4.5 gating adjacency demonstration: hard heat_source gate.
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: IspatGuru "Blast Furnace Body".
    // 30000 steel_beam shell + 25000 clay refractory + 2000 stone pad = 57 t.
    // cycle-break (P4C2b): removed pipe and sheet_metal per circular-deps invariant.
    placementCost: { steel_beam: 30000, clay: 25000, stone: 2000 },
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
    // The §6.7 "2 Scrap = 1 Pig iron's worth of steel input" substitution is
    // wired on THIS building: when there's no pig_iron stockpile but scrap
    // is on hand, `resolveRecipe` in recipes.ts swaps in the
    // `steel_mill_from_scrap` synthetic recipe (same 600s cycle, 2 scrap →
    // 1 steel + 1 slag) so output rate is preserved. The separate
    // `steel_mill_scrap` building (below) is a faster scrap-only T2
    // alternative, distinct from the substitution mechanic.
    // BOM source: EAF mini-mill (USA Steel TX).
    // 25000 steel_beam structure + 8000 clay refractory + 2000 stone pad = 35 t.
    // cycle-break (P4C2b): removed pipe and gear per circular-deps invariant.
    placementCost: { steel_beam: 25000, clay: 8000, stone: 2000 },
    glyph: '△',
  },
  // §6.7: Steel Mill Scrap — alternate T2 steel producer using scrap instead
  // of the pig-iron pathway. 2 Scrap = 1 Pig iron's worth of steel input.
  steel_mill_scrap: {
    id: 'steel_mill_scrap',
    displayName: 'Steel Mill (Scrap)',
    category: 'smelting',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x6e7480,
    stroke: 0x2a2e36,
    power: { consumes: 120 },
    // BOM source: IspatGuru, "EAF mini-mill scrap yard" — scrap-charging crane + EAF shell.
    // 20000 concrete + 15000 stone + 8000 iron_ingot + 500 gear + 5000 clay + 500 copper_ingot = 49.5 t.
    placementCost: { concrete: 20000, stone: 15000, iron_ingot: 8000, gear: 500, clay: 5000, copper_ingot: 500 },
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
    // BOM source: IspatGuru, "Slag reprocessing plant" — magnetic separator + ball mill.
    // 8000 concrete + 6000 stone + 2000 iron_ingot + 300 gear + 400 copper_ingot = 17.0 t.
    placementCost: { concrete: 8000, stone: 6000, iron_ingot: 2000, gear: 300, copper_ingot: 400 },
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
    // BOM source: Roberts, *Engineering Workshop* — medium assembly bench.
    // 7000 concrete + 4000 stone + 2000 iron_ingot + 500 glass + 300 copper_ingot = 13.8 t.
    placementCost: { concrete: 7000, stone: 4000, iron_ingot: 2000, glass: 500, copper_ingot: 300 },
    glyph: '⚙',
  },
  // Phase 6 — T2 rolling mills (§6.3 / §7.1)
  sheet_metal_mill: {
    id: 'sheet_metal_mill',
    displayName: 'Sheet Metal Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xb0b8c0,
    stroke: 0x505860,
    power: { consumes: 100 },
    // BOM source: IspatGuru, "Cold Rolling Mill" — 4-stand finishing-mill installation (scaled).
    // 12000 concrete + 8000 stone + 4000 iron_ingot + 300 gear + 3000 clay = 27.6 t.
    placementCost: { concrete: 12000, stone: 8000, iron_ingot: 4000, gear: 300, clay: 3000 },
    glyph: '▭',
  },
  pipe_mill: {
    id: 'pipe_mill',
    displayName: 'Pipe Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x9098a0,
    stroke: 0x404850,
    power: { consumes: 100 },
    // BOM source: Babcock & Wilcox, *Steam* 41e ch. 25 — pipe-mill forming stands.
    // 10000 concrete + 7000 stone + 3500 iron_ingot + 250 gear + 2500 clay + 300 copper_ingot = 23.8 t.
    // cycle-break (P4C6): swapped steel_beam + microchip → iron_ingot + clay to avoid the
    // microchip → pcb_etcher → ... → steel_beam 10-node cycle.
    placementCost: { concrete: 10000, stone: 7000, iron_ingot: 3500, gear: 250, clay: 2500, copper_ingot: 300 },
    glyph: '◯',
  },
  beam_mill: {
    id: 'beam_mill',
    displayName: 'Beam Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x707880,
    stroke: 0x303840,
    power: { consumes: 100 },
    // BOM source: Babcock & Wilcox, *Steam* 41e ch. 25 — beam-mill rolling stands.
    // 10000 concrete + 6000 stone + 3000 iron_ingot + 200 gear + 2000 clay + 200 copper_ingot = 21.6 t.
    // cycle-break (P4C6): swapped steel_beam + microchip → iron_ingot + clay to avoid the
    // microchip → pcb_etcher → ... → steel_beam 10-node cycle.
    placementCost: { concrete: 10000, stone: 6000, iron_ingot: 3000, gear: 200, clay: 2000, copper_ingot: 200 },
    glyph: '▬',
  },
  // Phase 6 — T2 mechanical fasteners (§6.3)
  bearing_assembler: {
    id: 'bearing_assembler',
    displayName: 'Bearing Assembler',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x8a9098,
    stroke: 0x3a4048,
    power: { consumes: 80 },
    // BOM source: IspatGuru, "Bearing assembly line" — raceway grinder + press.
    // 10000 concrete + 6000 stone + 3000 iron_ingot + 200 gear + 2000 clay + 300 copper_ingot = 21.7 t.
    placementCost: { concrete: 10000, stone: 6000, iron_ingot: 3000, gear: 200, clay: 2000, copper_ingot: 300 },
    glyph: '◉',
  },
  spring_press: {
    id: 'spring_press',
    displayName: 'Spring Press',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xa0a6a0,
    stroke: 0x404640,
    power: { consumes: 60 },
    // BOM source: IspatGuru, "Spring coiling press" — CNC spring former.
    // 8000 concrete + 5000 stone + 2500 iron_ingot + 150 gear + 1500 clay + 250 copper_ingot = 17.6 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2500, gear: 150, clay: 1500, copper_ingot: 250 },
    glyph: '⌇',
  },
  // Phase 6 — T2 mechanical components (§6.3)
  cable_mill: {
    id: 'cable_mill',
    displayName: 'Cable Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x8a8060,
    stroke: 0x3a3020,
    power: { consumes: 80 },
    // BOM source: IspatGuru, "Cable stranding line" — planetary cage strander.
    // 9000 concrete + 6000 stone + 2800 iron_ingot + 180 gear + 2000 clay + 400 copper_ingot = 20.6 t.
    placementCost: { concrete: 9000, stone: 6000, iron_ingot: 2800, gear: 180, clay: 2000, copper_ingot: 400 },
    glyph: '⌇',
  },
  // Phase 6 — T3 battery factory (§6.3 / §7.9)
  battery_factory: {
    id: 'battery_factory',
    displayName: 'Battery Factory',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x4a7040,
    stroke: 0x1a3010,
    power: { consumes: 200 },
    placementCost: { steel: 80, microchip: 5, glass: 10 },
    glyph: '🔋',
  },
  // Phase 6 — T2 glass_panel (§6.3)
  glass_panel_press: {
    id: 'glass_panel_press',
    displayName: 'Glass Panel Press',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xc0d0e0,
    stroke: 0x607080,
    power: { consumes: 60 },
    // BOM source: Roberts, *Engineering Workshop* — glass-panel pressing bench.
    // 5000 concrete + 3000 stone + 1500 iron_ingot + 100 gear + 1000 clay = 10.7 t.
    placementCost: { concrete: 5000, stone: 3000, iron_ingot: 1500, gear: 100, clay: 1000 },
    glyph: '▭',
  },
  // Phase 6 — T2 coolant + ceramic_insulator (§6.3)
  coolant_synthesizer: {
    id: 'coolant_synthesizer',
    displayName: 'Coolant Synthesizer',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x40a0c0,
    stroke: 0x103040,
    power: { consumes: 100 },
    // BOM source: ChemEng. handbook — small-batch coolant blending vessel.
    // 6000 concrete + 4000 stone + 1500 iron_ingot + 150 gear + 300 glass + 200 copper_ingot = 12.3 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 1500, gear: 150, glass: 300, copper_ingot: 200 },
    glyph: '❄',
  },
  ceramic_kiln: {
    id: 'ceramic_kiln',
    displayName: 'Ceramic Kiln',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xa06840,
    stroke: 0x402010,
    power: { consumes: 80 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: Roberts, *Engineering Workshop* — intermittent ceramic kiln.
    // 5000 concrete + 4000 stone + 1200 iron_ingot + 80 gear + 2000 clay = 12.4 t.
    placementCost: { concrete: 5000, stone: 4000, iron_ingot: 1200, gear: 80, clay: 2000 },
    glyph: '♨',
  },
  // Phase 7 — Bronze + Brass (§7.2)
  bronze_alloyer: {
    id: 'bronze_alloyer',
    displayName: 'Bronze Alloyer',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xb87333,
    stroke: 0x5a3a1a,
    power: { consumes: 80 },
    // BOM source: Roberts, *Engineering Workshop* — medium foundry ladle.
    // 5000 concrete + 3000 stone + 1000 iron_ingot + 100 gear + 500 copper_ingot = 9.7 t.
    placementCost: { concrete: 5000, stone: 3000, iron_ingot: 1000, gear: 100, copper_ingot: 500 },
    glyph: '◈',
  },
  brass_alloyer: {
    id: 'brass_alloyer',
    displayName: 'Brass Alloyer',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xd4a44a,
    stroke: 0x6a5225,
    power: { consumes: 80 },
    // BOM source: Roberts, *Engineering Workshop* — medium foundry ladle.
    // 5000 concrete + 3000 stone + 1000 iron_ingot + 100 gear + 500 copper_ingot = 9.7 t.
    placementCost: { concrete: 5000, stone: 3000, iron_ingot: 1000, gear: 100, copper_ingot: 500 },
    glyph: '◈',
  },
  // Phase 8 — Aluminum chain (§7.3)
  alumina_refinery: {
    id: 'alumina_refinery',
    displayName: 'Alumina Refinery',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xd0a060,
    stroke: 0x605030,
    power: { consumes: 150 },
    // BOM source: ChemEng. handbook — Bayer-process digestion vessel (scaled).
    // 8000 concrete + 5000 stone + 2000 iron_ingot + 150 gear + 1500 clay = 16.8 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2000, gear: 150, clay: 1500 },
    glyph: '△',
  },
  aluminum_smelter: {
    id: 'aluminum_smelter',
    displayName: 'Aluminum Smelter',
    category: 'smelting',
    tier: 3,
    footprint: SHAPES.rect2x3,
    fill: 0xc0c4cb,
    stroke: 0x50545a,
    power: { consumes: 500 },
    placementCost: { steel: 80, microchip: 5 },
    glyph: '△',
  },
  tank: {
    id: 'tank',
    displayName: 'Tank',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x2a4078,
    stroke: 0x0a1a3a,
    // rev-16 §13.3: +100000 cap (100 t), liquids/gases category only.
    // Kennedy Tank mid-class industrial analog.
    storage: { category: 'liquid_gas', capacity: 100000 },
    // BOM source: Kennedy Tank — mid-class industrial chemical tank (scaled).
    // 6000 concrete + 4000 stone + 1500 iron_ingot + 100 gear + 200 glass = 11.9 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 1500, gear: 100, glass: 200 },
    glyph: '▦',
  },
  // rev-16 §13.3: Cold Storage — T2 specialized storage for temperature-
  // sensitive resources (cryogenic compound, cryo-coolant, liquid nitrogen,
  // certain plastics). +50000 cap (50 t). Refrigerated warehouse module
  // analog. Cool steel-grey fill keys to the refrigeration role.
  cold_storage: {
    id: 'cold_storage',
    displayName: 'Cold Storage',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x8090a0,
    stroke: 0x2a3848,
    storage: { category: 'temp_sensitive', capacity: 50000 },
    // BOM source: Small refrigerated warehouse module — insulated shell + compressor pad.
    // 7000 concrete + 4000 stone + 1500 iron_ingot + 120 gear + 300 copper_ingot = 13.0 t.
    placementCost: { concrete: 7000, stone: 4000, iron_ingot: 1500, gear: 120, copper_ingot: 300 },
    glyph: '▦',
  },
  // rev-16 §13.3: Component Warehouse — T2 specialized storage for
  // manufactured T2-T3 components (wire, bolt, gear, microchip, etc.).
  // +20000 cap (20 t). Industrial pallet-racked warehouse analog.
  // Industrial-tan fill keys to the parts-warehouse role.
  component_warehouse: {
    id: 'component_warehouse',
    displayName: 'Component Warehouse',
    category: 'storage',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x806840,
    stroke: 0x3a2810,
    storage: { category: 'components', capacity: 20000 },
    // BOM source: Industrial pallet-racked components warehouse — steel-shelf frame.
    // 5000 concrete + 3000 stone + 1200 iron_ingot + 200 gear + 200 copper_ingot = 9.8 t.
    placementCost: { concrete: 5000, stone: 3000, iron_ingot: 1200, gear: 200, copper_ingot: 200 },
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
    // BOM source: Vernacular civil engineering — land-reclamation control hub.
    // 15000 concrete + 10000 stone + 5000 iron_ingot + 400 gear + 3000 clay = 33.8 t.
    placementCost: { concrete: 15000, stone: 10000, iron_ingot: 5000, gear: 400, clay: 3000 },
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
    // BOM source: Vernacular civil engineering — terrain-grading blade + hydraulic frame.
    // 200 steel_beam + 5000 concrete + 100 gear + 80 pipe + 10 microchip = 15.5 t.
    placementCost: { steel_beam: 200, concrete: 5000, gear: 100, pipe: 80, microchip: 10 },
    glyph: '◈',
    terrainModifier: true,
    instantBuild: true,
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
    // BOM source: Linde cryocooler datasheet.
    // 500 steel_beam + 100 ceramic_insulator + 50 gear + 30 glass + 20 pipe = 810 kg.
    placementCost: { steel_beam: 500, ceramic_insulator: 100, gear: 50, glass: 30, pipe: 20 },
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
    // rev-16 §5.3: 200 kW elec × 92% transferred-arc eff (ABB).
    heatSource: { freeOrCoal: 'free', thermalKW: 184 },
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
    // rev-16 §5.3: residual refractory hold-temp; main heat from electrodes.
    heatDemandKW: 80,
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
  // is STILL-DEFERRED. Power-consumption is declared per §5.1 so a future-step
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
    // BOM source: IAEA ARIS NuScale SMR.
    // 200000 steel_beam vessel + 600000 concrete shield + 30000 lead_ingot shielding
    // + 2000 microchip control + 500 pipe cooling = 832 t.
    placementCost: { steel_beam: 200000, concrete: 600000, lead_ingot: 30000, microchip: 2000, pipe: 500 },
    glyph: '☢',
  },
  // §8.7 T2 cooling: Cooling Tower (2x2). Adjacency anchor. The spec's
  // "Crystal Growth Lab unlocks rare recipes" example requires a Crystal
  // Lab building (not in the catalog yet); when that ships, wire its
  // recipe gate to require an adjacent Cooling Tower.
  cooling_tower: {
    id: 'cooling_tower',
    displayName: 'Cooling Tower',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x6090c0, // cool-blue tower
    stroke: 0x102040,
    power: { consumes: 40 },
    // BOM source: Babcock & Wilcox, *Steam* 41e ch. 25 — induced-draft cooling tower.
    // 250 steel_beam + 6000 concrete + 80 gear + 120 pipe + 300 glass = 19.4 t.
    placementCost: { steel_beam: 250, concrete: 6000, gear: 80, pipe: 120, glass: 300 },
    glyph: '❅',
  },
  // §8.7 T2 treatment: Wastewater Treatment (2x2). Adjacency anchor —
  // prevents efficiency penalty for chemistry per §4.5 ("Refinery without
  // adjacent Wastewater Treatment operates only on low-grade recipe,
  // efficiency -50%"). Consumer-side wiring lives on the §4.5 gate of
  // each chemistry plant (sulfuric_acid_plant, hcl_plant,
  // chlor_alkali_plant); missing adjacency halves their output via
  // `degradeMul: 0.5`.
  wastewater_treatment: {
    id: 'wastewater_treatment',
    displayName: 'Wastewater Treatment',
    category: 'special',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x4a7060, // murky water-treatment teal
    stroke: 0x0a1810,
    power: { consumes: 30 },
    // BOM source: EPA WW-treatment — activated-sludge basin + clarifier (scaled).
    // 200 steel_beam + 8000 concrete + 100 gear + 150 pipe + 2000 clay = 20.8 t.
    placementCost: { steel_beam: 200, concrete: 8000, gear: 100, pipe: 150, clay: 2000 },
    glyph: '⌇',
  },
  // §8.7 T2 emissions: Exhaust Scrubber (1x1). Required for clean
  // operation of high-emission buildings. Consumer-side wiring lives on
  // the §4.5 gate on each emission-heavy def — currently coke_oven,
  // naphtha_cracker, lubricant_refinery, diesel_refinery — each a soft
  // gate (`def_id: exhaust_scrubber`, `degradeMul: 0.5`) so missing
  // adjacency halves output but doesn't stall.
  exhaust_scrubber: {
    id: 'exhaust_scrubber',
    displayName: 'Exhaust Scrubber',
    category: 'special',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x807060, // smokestack grey-brown
    stroke: 0x201810,
    power: { consumes: 20 },
    // BOM source: EPA scrubber design manual — packed-bed SO₂ scrubber.
    // 80 steel_beam + 1500 concrete + 30 gear + 50 pipe + 500 clay = 6.3 t.
    placementCost: { steel_beam: 80, concrete: 1500, gear: 30, pipe: 50, clay: 500 },
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
    // rev-16 §5.3: ITER Q=10 thermal 1 GW = 1_000_000 kW.
    heatSource: { freeOrCoal: 'free', thermalKW: 1000000 },
    // BOM source: ITER Tokamak technical reports.
    // 12000 steel_beam + 8000 magnet + 4000 stainless_steel + 2000 microchip + 1000 cryo_coolant
    // + 500 exotic_alloy + 200 carbon_fiber = 417.9 t.
    placementCost: { steel_beam: 12000, magnet: 8000, stainless_steel: 4000, microchip: 2000, cryo_coolant: 1000, exotic_alloy: 500, carbon_fiber: 200 },
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
    // rev-16 §5.3: Tetronics DC plasma reactor hold-temp.
    heatDemandKW: 200,
    // BOM source: Tetronics DC plasma arc.
    // 10000 steel_beam vessel + 3000 clay refractory + 500 microchip control + 200 ceramic_insulator = 13.7 t.
    // cycle-break (P4C2b): removed exotic_alloy per circular-deps invariant.
    placementCost: { steel_beam: 10000, clay: 3000, microchip: 500, ceramic_insulator: 200 },
    glyph: '◉',
  },
  // §9.5: Cryogenic Compute Center — Arctic-unique. Only producer of AI
  // Cores. Arctic ambient cold should halve compute-recipe power draw (§9.5
  // intrinsic bonus); currently a tuning placeholder, modelled at static
  // 1200W pending balance pass.
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
    // BOM source: IBM Quantum System Two.
    // 15000 steel_beam frame + 5000 ceramic_insulator + 1000 microchip + 500 cryo_coolant + 200 wire = 20.7 t.
    // cycle-break (P4C2b): removed ai_core per circular-deps invariant.
    placementCost: { steel_beam: 15000, ceramic_insulator: 5000, microchip: 1000, cryo_coolant: 500, wire: 200 },
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
    // rev-16 §5.3: PAN-fiber oxidation oven (Hexcel + Toray).
    heatDemandKW: 150,
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
    // BOM source: MeyGen Phase 1A datasheet.
    // 12000 steel_beam turbine frame + 2000 concrete pad + 500 magnet + 200 wire + 100 gear = 39.3 t.
    placementCost: { steel_beam: 12000, concrete: 2000, magnet: 500, wire: 200, gear: 100 },
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
    // §2.7: SPEC line 277 lists Sunspire alongside Solar Panel as a "solar
    // building" — its 60 MW output modulates by the day-night curve
    // (Day 1.0×, Dawn/Dusk linear ramp, Night 0.0×). The §5.1 producer-
    // summing loop in economy.ts gates wattage when `power.solar === true`.
    power: { produces: 60000, solar: true },  // 60 MW placeholder
    requiredBiomes: ['desert'],
    // BOM source: Ivanpah heliostat reference.
    // 8000 steel_beam tower + 4000 glass heliostat + 1000 stone pad + 200 microchip + 100 coolant = 13.3 t.
    placementCost: { steel_beam: 8000, glass: 4000, stone: 1000, microchip: 200, coolant: 100 },
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
    // BOM source: CERN LEIR scaled-down.
    // 25000 steel_beam ring + 3000 concrete pad + 2000 magnet + 1000 microchip + 200 cryo_coolant = 128.3 t.
    placementCost: { steel_beam: 25000, concrete: 3000, magnet: 2000, microchip: 1000, cryo_coolant: 200 },
    glyph: '◈',
  },
  // §8.8 / §11.5: Launch Tower — T4 omnidirectional drone-pulse launch
  // site. The pulse mechanic (3-cell-radius single-disk reveal) is wired
  // via `firePulse`.
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
  // Phase 11 — T4 endgame (Task 11.1): Quantum Manipulator → time_crystal.
  quantum_manipulator: {
    id: 'quantum_manipulator',
    displayName: 'Quantum Manipulator',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0xb060e0,
    stroke: 0x401060,
    power: { consumes: 1000 },
    placementCost: { steel: 300, microchip: 50, glass: 30 },
    glyph: '✺',
  },
  // Phase 11 — T4 endgame (Task 11.2): Quantum Chip Fabricator replaces
  // particle_accelerator as the quantum_chip producer.
  quantum_chip_fab: {
    id: 'quantum_chip_fab',
    displayName: 'Quantum Chip Fabricator',
    category: 'electronics',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x8060c0,
    stroke: 0x301050,
    power: { consumes: 1500 },
    // BOM source: TSMC fab-line refs (cleanroom only).
    // 8000 steel_beam frame + 4000 glass + 2000 microchip + 1000 ceramic_insulator + 200 silicon_wafer = 12.3 t.
    // cycle-break (P4C2b): removed ai_core per circular-deps invariant.
    placementCost: { steel_beam: 8000, glass: 4000, microchip: 2000, ceramic_insulator: 1000, silicon_wafer: 200 },
    glyph: '◈',
  },
  // Phase 11 — T4 endgame (Task 11.3): Fuel Rod Assembler → nuclear_fuel_rod.
  fuel_rod_assembler: {
    id: 'fuel_rod_assembler',
    displayName: 'Fuel Rod Assembler',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x40c050,
    stroke: 0x103820,
    power: { consumes: 400 },
    placementCost: { steel: 200, microchip: 30, glass: 20 },
    glyph: '⚡',
  },
  // Phase 11 — T4 endgame (Task 11.4): Five T4 component assemblers.
  plasma_containment_assembler: {
    id: 'plasma_containment_assembler',
    displayName: 'Plasma Containment Assembler',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0xff6030,
    stroke: 0x802010,
    power: { consumes: 600 },
    placementCost: { steel: 250, exotic_alloy: 20, microchip: 30 },
    glyph: '◎',
  },
  singularity_sensor_lab: {
    id: 'singularity_sensor_lab',
    displayName: 'Singularity Sensor Lab',
    category: 'electronics',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x40a0f0,
    stroke: 0x104060,
    power: { consumes: 500 },
    placementCost: { steel: 250, quantum_chip: 10, glass: 40 },
    glyph: '◉',
  },
  cryo_containment_assembler: {
    id: 'cryo_containment_assembler',
    displayName: 'Cryo Containment Assembler',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x60d0e0,
    stroke: 0x105060,
    power: { consumes: 500 },
    placementCost: { steel: 250, cryogenic_compound: 15, glass: 30 },
    glyph: '❄',
  },
  accelerator_core_lab: {
    id: 'accelerator_core_lab',
    displayName: 'Accelerator Core Lab',
    category: 'electronics',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0xe0a020,
    stroke: 0x604010,
    power: { consumes: 800 },
    placementCost: { steel: 300, exotic_alloy: 25, optical_fiber: 20 },
    glyph: '✦',
  },
  self_replication_lab: {
    id: 'self_replication_lab',
    displayName: 'Self-Replication Lab',
    category: 'manufacturing',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x50e080,
    stroke: 0x106030,
    power: { consumes: 700 },
    placementCost: { steel: 350, ai_core: 2, microchip: 50, electric_motor: 20 },
    glyph: '↻',
  },
  // §04: Skill Forge — T4 production building for crafting Skill Crystals.
  // 2×2 footprint, high power draw (1500W operating; standby not modelled
  // separately — single `consumes` figure captures operating load).
  skill_forge: {
    id: 'skill_forge',
    displayName: 'Skill Forge',
    category: 'production',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0xa050c0,
    stroke: 0x401060,
    power: { consumes: 1500 },
    placementCost: { microchip: 40, ai_core: 8, reality_anchor: 4 },
    glyph: '◈',
  },
  // -------------------------------------------------------------------------
  // T5 (levels 50+, AI Core required) — Transcendent per §13 / step 13
  // -------------------------------------------------------------------------
  // §8.5 / §8.10: Casimir Tap — T5 power source AND raw extractor for
  // Casimir energy / Zero-point flux. Step-13 simplification: declared as a
  // power producer (8000W placeholder; §8.5 says "free vacuum energy") with
  // a slow recipe emitting `casimir_energy`. Full §8.10 dual-output cycle
  // (Casimir energy OR Zero-point flux per cycle) is STILL-DEFERRED; the
  // §8.10 30-minute cycle time is shipped (1800s) — step-13 recipe uses it for the
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
    placementCost: { steel: 200, microchip: 100 },
    glyph: '✺',
  },
  // §8.4: Singularity Battery — "effectively infinite electrical power
  // storage" per spec. Wired into the §5.1 power balance: contributes to
  // the shared `batteryStoredWs` buffer (summed across all battery tiers)
  // that charges from surplus and discharges into deficits (see `economy.ts`
  // brownout path). Per the §8.4 note ("not a resource storage building")
  // this def carries NO `storage` contribution — it never raises any
  // resource cap. Zero standby — generalised battery system has no idle draw.
  singularity_battery: {
    id: 'singularity_battery',
    displayName: 'Singularity Battery',
    category: 'power',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x202060, // deep ultramarine
    stroke: 0x0a0a30,
    power: { consumes: 0 },
    // §14 placeholder — tune in Appendix A.
    placementCost: { reality_anchor: 50, steel: 100, microchip: 50 },
    glyph: '▦',
  },
  // §8.9 / §13.3: Time Lock — banks offline-time stockpile per island and
  // spends to accelerate any chosen island's tick rate at 3×. Banking +
  // spending + acceleration queue all live (see `timeLockBankedMin` +
  // `accelerationQueue` + `accelerationRemainingMin` on IslandState).
  // The Time Lock def itself only declares standby power here.
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
  // draw). Free-creation mechanic per §13.3 is live — see
  // `src/economy.ts:542-598, 792-804`. No recipe (the player-target-resource
  // selection isn't a fixed inputs→outputs recipe).
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
  // regenerates terrain. Player triggers via the inspector's "Universe
  // Editor" section when this building is selected: pick a target biome
  // and the Editor consumes UNIVERSE_EDITOR_COST, mutates `spec.biome`,
  // re-rolls modifiers (excluding natural-only), and marks now-invalid
  // buildings via `editIslandBiome` in `universe-editor.ts`.
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
  // enough nodes are placed across T5-mastered islands. Activation is
  // live (see `latticeActive` + `latticeNodeIslands` on WorldState and
  // the unified-inventory path in `economy.ts`); the node itself only
  // declares standby power here.
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
  // §13.4 Genesis Forge: produces the genesis_cell T5 transcendent
  // artifact. Per spec — 24h cycle, recipe at recipes.ts. T5 manufacturing,
  // 4×4 footprint matching Ascendant Assembly's weight. Placement cost
  // mirrors Ascendant Assembly so the two long-cycle endgame producers
  // are economically interchangeable. NOT a victory artifact (idle game,
  // no finish state per §13.4).
  genesis_forge: {
    id: 'genesis_forge',
    displayName: 'Genesis Forge',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square4,
    fill: 0x60d0a0, // genesis mint
    stroke: 0x205040,
    power: { consumes: 4000 },
    placementCost: { reality_anchor: 100, steel: 200, microchip: 100 },
    glyph: '✺',
  },
  // -------------------------------------------------------------------------
  // T6 (Ascendant Core + Spaceport, §14) — Orbital per step 20
  // -------------------------------------------------------------------------
  //
  // The §14.2-14.8 / §14.12 live mechanics — Spaceport tier I/II/III
  // upgrade lifecycle, satellite launches as a concurrent slot, scheduled
  // launches with success rolls, orbital debris fields, Kessler-cascade
  // chains, comm-graph data delivery, lodge events, Repair Drone
  // operations, dwell-ramp discovery — and the §14.9 four Orbital skill
  // sub-paths (Launch / Communication / Discovery / Resilience) are all
  // wired through `orbital.ts`.
  //
  // The §14.1 access gate (level 50 + AI core + Ascendant Core crafted +
  // Spaceport placed) is composed in `buildingUnlocked` below. Spaceport
  // itself is exempt from the "Spaceport placed" half of the gate
  // (otherwise it'd be unbuildable — chicken-and-egg per §14.1's literal
  // reading).

  // §14.2 Spaceport — single building serving as launch facility, ground-
  // side comm antenna, and repair-launch facility. Tier I/II/III in-place
  // upgrade lifecycle live (`upgradeSpaceport` in orbital.ts; UI button in
  // orbital-ui.ts). §14.7 pad-explosion reverts the spaceport to tier I
  // rather than destroying it. No recipe — this is a special placement
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
    // BOM source: Rocket Lab LC-1 + NASA LC-39A.
    // 50000 steel_beam structure + 200000 concrete pad + 5000 microchip + 10000 pipe + 500 wire
    // + 100 antimatter_propellant + 100 reality_anchor = 291 t.
    placementCost: { steel_beam: 50000, concrete: 200000, microchip: 5000, pipe: 10000, wire: 500, antimatter_propellant: 100, reality_anchor: 100 },
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
  // §7.12 / §11.7 / §14.10: Antimatter Refinery — produces Antimatter
  // Propellant (T6 launch fuel). §7.12 spec literal: 1 antimatter_capsule
  // + 1 plasma_containment_vessel + 5 cryogenic_hydrogen / 30 min cycle.
  // See `recipes.ts antimatter_refinery` for the canonical definition.
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
    placementCost: { steel: 150, reality_anchor: 75 },
    glyph: '✦',
  },
  // rev-16 §10.13 — industrial-scale concrete output, 100 concrete / 60 s = 6 t/hr.
  // BOM source: Schwing Stetter CP-30 batching-plant datasheet.
  // 8000 steel structure + 2000 stone aggregate-bin + 500 microchip control
  // + 500 pipe slurry + 200 gear mixer + 100 wire = 12.5 t embodied.
  bulk_concrete_plant: {
    id: 'bulk_concrete_plant',
    displayName: 'Bulk Concrete Plant',
    category: 'manufacturing',
    tier: 6,
    // SHAPES.square3 — rect3x4 not in catalog.
    footprint: SHAPES.square3,
    fill: 0xa0a0a0,
    stroke: 0x303030,
    power: { consumes: 2000 },
    placementCost: { steel_beam: 8000, stone: 2000, microchip: 500, pipe: 500, gear: 200, wire: 100 },
    glyph: '▣',
  },
  // §14.3 / §14.10: Scanner Sat Assembly — produces Scanner Sat payloads
  // for §14.3 discovery + weather observation.
  scanner_sat_assembly: {
    id: 'scanner_sat_assembly',
    displayName: 'Scanner Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x4080a0,
    stroke: 0x20303a,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '◇',
  },
  // §14.3 / §14.10: Relay Sat Assembly — produces Relay Sat payloads for
  // §14.4 comm-graph extension.
  relay_sat_assembly: {
    id: 'relay_sat_assembly',
    displayName: 'Relay Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xa040c0,
    stroke: 0x303a20,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '◇',
  },
  // §14.3 / §14.10: Sweeper Sat Assembly — produces Sweeper Sat payloads
  // for §14.8 debris-field / Kessler-cascade clearing.
  sweeper_sat_assembly: {
    id: 'sweeper_sat_assembly',
    displayName: 'Sweeper Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x709020,
    stroke: 0x203030,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '◇',
  },
  // §14.3 / §14.10: Mirror Sat Assembly — produces Mirror Sat payloads for
  // §14.3 orbital reflectors that additively boost effective solar output
  // on ground islands within their Lorentzian range (§2.7 composition).
  // Stats mirror the other *_sat_assembly buildings: T6, square3, 600W,
  // identical placementCost so all four sat assemblies cost the same
  // physical investment (the variant cost lives in §14.10 recipe inputs).
  mirror_sat_assembly: {
    id: 'mirror_sat_assembly',
    displayName: 'Mirror Sat Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xd0b040,
    stroke: 0x402a10,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '◇',
  },
  // §14.7 / §14.10: OIP Assembly — produces Orbital Insertion Packages
  // (T6 Foundation-Kit equivalent). Every §14.7 satellite launch requires
  // one alongside fuel + variant recipe.
  oip_assembly: {
    id: 'oip_assembly',
    displayName: 'OIP Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x408060,
    stroke: 0x403014,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '⚙',
  },
  // §14.12 / §14.10: Repair Pack Assembly — produces Repair Pack consumables
  // for orbital drone repair operations.
  repair_pack_assembly: {
    id: 'repair_pack_assembly',
    displayName: 'Repair Pack Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0x806040,
    stroke: 0x402818,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '⚙',
  },
  // §14.12 / §14.10: Repair Drone Assembly — produces Repair Drone units.
  repair_drone_assembly: {
    id: 'repair_drone_assembly',
    displayName: 'Repair Drone Assembly',
    category: 'manufacturing',
    tier: 6,
    footprint: SHAPES.square3,
    fill: 0xa06060,
    stroke: 0x402020,
    power: { consumes: 600 },
    placementCost: { steel: 250, microchip: 60, glass: 30 },
    glyph: '◇',
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Manual dimension-stone quarry: 120 kg stone blocks + 80 kg wood frame + 30 kg iron picks = 230 kg.
    placementCost: { stone: 120, wood: 80, iron_ingot: 30 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Manual sand-pit screening frame: 120 kg stone lining + 80 kg wood + 20 kg iron = 220 kg.
    placementCost: { stone: 120, wood: 80, iron_ingot: 20 },
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
    // BOM source: Vernacular civil engineering — hand-dug freshwater well.
    // 20 kg stone curb + 20 kg wood windlass + 5 kg iron bucket = 45 kg.
    placementCost: { stone: 20, wood: 20, iron_ingot: 5 },
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
    // BOM source: Vernacular civil engineering — hand-driven coastal well.
    // 30 kg stone curb + 20 kg wood frame + 10 kg iron pump hardware = 60 kg.
    placementCost: { stone: 30, wood: 20, iron_ingot: 10 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small silica vein open cut: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Manual limestone quarry face: 150 kg stone blocks + 80 kg wood frame + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Manual clay-pit winch and screen: 140 kg stone lining + 80 kg wood frame = 220 kg.
    // cycle-break (P4C5): removed iron_ingot per circular-deps invariant.
    placementCost: { stone: 140, wood: 80 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small sulfur deposit open pit: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small phosphate rock quarry: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
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
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small graphite vein adit: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  copper_mine: {
    id: 'copper_mine',
    displayName: 'Copper Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xb87333, // copper oxide orange
    stroke: 0x5a3018,
    power: { consumes: 30 },
    requiredTile: ['copper_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small copper-oxide pit head-frame: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  tin_mine: {
    id: 'tin_mine',
    displayName: 'Tin Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc0c4cb, // pale tin-grey
    stroke: 0x505458,
    power: { consumes: 30 },
    requiredTile: ['tin_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small cassiterite placer pit: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  lead_mine: {
    id: 'lead_mine',
    displayName: 'Lead Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x4a4a52, // dark lead-grey
    stroke: 0x202024,
    power: { consumes: 30 },
    requiredTile: ['lead_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small galena open-cut head-frame: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  bauxite_mine: {
    id: 'bauxite_mine',
    displayName: 'Bauxite Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xd07845, // bauxite ochre
    stroke: 0x6a4028,
    power: { consumes: 30 },
    requiredTile: ['bauxite_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small open-pit bauxite extractor: 150 kg foundation stone + 80 kg wood frame + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  // Phase 2 — T1 refined chains (§6.2 / §7.5)
  limekiln: {
    id: 'limekiln',
    displayName: 'Limekiln',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xb0a890, // warm limestone grey
    stroke: 0x504838,
    power: { consumes: 60 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: Roberts, *Engineering Workshop* — flare kiln analog.
    // 200 kg stone firebricks + 40 kg wood fuel rack + 30 kg iron door + 50 kg clay lining = 320 kg.
    placementCost: { stone: 200, wood: 40, iron_ingot: 30, clay: 50 },
    glyph: '△',
  },
  lime_slaker: {
    id: 'lime_slaker',
    displayName: 'Lime Slaker',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc4c0b0, // pale slaked-lime beige
    stroke: 0x605850,
    power: { consumes: 30 },
    // BOM source: Roberts, *Engineering Workshop* — slaking tank.
    // 150 kg stone tank + 30 kg wood frame + 20 kg iron paddle = 200 kg.
    placementCost: { stone: 150, wood: 30, iron_ingot: 20 },
    glyph: '◇',
  },
  brick_kiln: {
    id: 'brick_kiln',
    displayName: 'Brick Kiln',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa05030, // terracotta
    stroke: 0x402010,
    power: { consumes: 50 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: Roberts, *Engineering Workshop* — clamp kiln analog.
    // 200 kg stone firebricks + 40 kg wood fuel rack + 20 kg iron door + 60 kg clay lining = 320 kg.
    placementCost: { stone: 200, wood: 40, iron_ingot: 20, clay: 60 },
    glyph: '△',
  },
  mortar_mixer: {
    id: 'mortar_mixer',
    displayName: 'Mortar Mixer',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xb8a878, // sand-beige
    stroke: 0x504830,
    power: { consumes: 30 },
    // BOM source: Roberts, *Engineering Workshop* — small paddle mixer.
    // 150 kg stone trough + 30 kg wood frame + 20 kg iron paddle = 200 kg.
    placementCost: { stone: 150, wood: 30, iron_ingot: 20 },
    glyph: '⚙',
  },
  cement_mill: {
    id: 'cement_mill',
    displayName: 'Cement Mill',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x888078, // cement grey
    stroke: 0x403830,
    power: { consumes: 80 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: Roberts, *Engineering Workshop* — small ball-mill installation.
    // 200 kg stone foundation + 60 kg iron drum + 30 kg wood frame = 290 kg.
    placementCost: { stone: 200, iron_ingot: 60, wood: 30 },
    glyph: '△',
  },
  concrete_plant: {
    id: 'concrete_plant',
    displayName: 'Concrete Plant',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x9a9488, // concrete grey
    stroke: 0x4a4538,
    power: { consumes: 60 },
    // BOM source: Roberts, *Engineering Workshop* — small batch mixer.
    // 150 kg stone pad + 40 kg iron drum + 40 kg wood frame + 20 kg clay seal = 250 kg.
    placementCost: { stone: 150, iron_ingot: 40, wood: 40, clay: 20 },
    glyph: '◈',
  },
  charcoal_kiln: {
    id: 'charcoal_kiln',
    displayName: 'Charcoal Kiln',
    category: 'chemistry',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x1a1a1a, // anthracite
    stroke: 0x080808,
    power: { consumes: 40 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    // BOM source: Roberts, *Engineering Workshop* — earth-mound kiln analog.
    // 150 kg stone ring + 80 kg wood structural + 20 kg iron grate = 250 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 20 },
    glyph: '△',
  },
  plank_mill: {
    id: 'plank_mill',
    displayName: 'Plank Mill',
    category: 'manufacturing',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc8a060, // sawn-wood tan
    stroke: 0x503818,
    power: { consumes: 30 },
    // BOM source: Roberts, *Engineering Workshop* — saw-pit headrig.
    // 100 kg stone foundation + 80 kg wood frame + 20 kg iron saw = 200 kg.
    placementCost: { stone: 100, wood: 80, iron_ingot: 20 },
    glyph: '⌬',
  },
  copper_smelter: {
    id: 'copper_smelter',
    displayName: 'Copper Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xb87333, // copper oxide orange
    stroke: 0x5a3018,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  tin_smelter: {
    id: 'tin_smelter',
    displayName: 'Tin Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xc0c4cb, // pale tin-grey
    stroke: 0x505458,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  lead_smelter: {
    id: 'lead_smelter',
    displayName: 'Lead Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x4a4a52, // dark lead-grey
    stroke: 0x202024,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  solder_alloyer: {
    id: 'solder_alloyer',
    displayName: 'Solder Alloyer',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x909498, // solder silver-grey
    stroke: 0x404448,
    power: { consumes: 80 },
    // BOM source: Roberts, *Engineering Workshop* — solder pot + flux bath.
    // 5000 concrete + 3000 stone + 1000 iron_ingot + 80 gear + 400 copper_ingot + 300 lead_ingot = 9.9 t.
    placementCost: { concrete: 5000, stone: 3000, iron_ingot: 1000, gear: 80, copper_ingot: 400, lead_ingot: 300 },
    glyph: '⚙',
  },

  // ---------------------------------------------------------------------------
  // Phase 3 — T2-T3 steel alloy chains (§6.1 / §6.4 / §7.1)
  // ---------------------------------------------------------------------------
  // Task 3.1: Carbon steel — manganese_ore + manganese_ingot + carbon_steel
  manganese_mine: {
    id: 'manganese_mine',
    displayName: 'Manganese Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x7e4d6f,
    stroke: 0x3a2030,
    power: { consumes: 40 },
    requiredTile: ['manganese_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small pyrolusite surface cut: 160 kg stone + 80 kg wood + 30 kg iron picks = 270 kg.
    placementCost: { stone: 160, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  manganese_smelter: {
    id: 'manganese_smelter',
    displayName: 'Manganese Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x7e4d6f,
    stroke: 0x3a2030,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  carbon_steel_mill: {
    id: 'carbon_steel_mill',
    displayName: 'Carbon Steel Mill',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x9a3030,
    stroke: 0x3a1010,
    power: { consumes: 150 },
    // BOM source: IspatGuru, "Carbon steel rolling mill" — manganese-alloying line.
    // 18000 concrete + 12000 stone + 8000 iron_ingot + 400 gear + 6000 clay + 600 copper_ingot = 45.4 t.
    placementCost: { concrete: 18000, stone: 12000, iron_ingot: 8000, gear: 400, clay: 6000, copper_ingot: 600 },
    glyph: '◈',
  },

  // Task 3.2: Galvanized steel — zinc_ore + zinc_ingot + galvanizing_bath
  zinc_mine: {
    id: 'zinc_mine',
    displayName: 'Zinc Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x8c93a0,
    stroke: 0x3a4048,
    power: { consumes: 40 },
    requiredTile: ['zinc_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small sphalerite open cut: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  zinc_smelter: {
    id: 'zinc_smelter',
    displayName: 'Zinc Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x8c93a0,
    stroke: 0x3a4048,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  galvanizing_bath: {
    id: 'galvanizing_bath',
    displayName: 'Galvanizing Bath',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x8c93a0,
    stroke: 0x3a4048,
    power: { consumes: 150 },
    // BOM source: IspatGuru, "Hot-dip galvanizing line" — zinc kettle + flux box.
    // 16000 concrete + 10000 stone + 7000 iron_ingot + 350 gear + 5000 clay + 500 copper_ingot = 39.2 t.
    placementCost: { concrete: 16000, stone: 10000, iron_ingot: 7000, gear: 350, clay: 5000, copper_ingot: 500 },
    glyph: '◈',
  },

  // Task 3.3: Stainless steel — chromium_ore + nickel_ore + ingots + stainless_steel
  chromium_mine: {
    id: 'chromium_mine',
    displayName: 'Chromium Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x5c6068,
    stroke: 0x202428,
    power: { consumes: 40 },
    requiredTile: ['chromium_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small chromite strip-mine head-frame: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  chromium_smelter: {
    id: 'chromium_smelter',
    displayName: 'Chromium Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x5c6068,
    stroke: 0x202428,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  nickel_mine: {
    id: 'nickel_mine',
    displayName: 'Nickel Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa0a098,
    stroke: 0x484840,
    power: { consumes: 40 },
    requiredTile: ['nickel_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small laterite nickel pit: 150 kg stone + 80 kg wood + 30 kg iron picks = 260 kg.
    placementCost: { stone: 150, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  nickel_smelter: {
    id: 'nickel_smelter',
    displayName: 'Nickel Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0xa0a098,
    stroke: 0x484840,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  stainless_steel_mill: {
    id: 'stainless_steel_mill',
    displayName: 'Stainless Steel Mill',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xa0a098,
    stroke: 0x484840,
    power: { consumes: 250 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    placementCost: { stone: 200, iron_ingot: 80, wood: 30 },
    glyph: '◈',
  },

  // Task 3.4: Tool steel — tungsten_ore + tungsten_ingot + tool_steel
  tungsten_mine: {
    id: 'tungsten_mine',
    displayName: 'Tungsten Mine',
    category: 'extraction',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x4a5060,
    stroke: 0x1a2028,
    power: { consumes: 40 },
    requiredTile: ['tungsten_vein'],
    // BOM source: Hartman & Mutmansky, *SME Mining Engineering Handbook* ch. 12.
    // Small wolframite vein adit: 160 kg stone + 80 kg wood + 30 kg iron picks = 270 kg.
    placementCost: { stone: 160, wood: 80, iron_ingot: 30 },
    glyph: '⛏',
  },
  tungsten_smelter: {
    id: 'tungsten_smelter',
    displayName: 'Tungsten Smelter',
    category: 'smelting',
    tier: 1,
    footprint: SHAPES.square2,
    fill: 0x4a5060,
    stroke: 0x1a2028,
    power: { consumes: 50 },
    // BOM source: Roberts, *Engineering Workshop* — small reverberatory furnace.
    // 200 kg stone firebricks + 80 kg iron frame + 30 kg wood formwork + 40 kg clay lining = 350 kg.
    placementCost: { stone: 200, iron_ingot: 80, wood: 30, clay: 40 },
    glyph: '△',
  },
  tool_steel_mill: {
    id: 'tool_steel_mill',
    displayName: 'Tool Steel Mill',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x4a5060,
    stroke: 0x1a2028,
    power: { consumes: 250 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    placementCost: { stone: 200, iron_ingot: 80, wood: 30 },
    glyph: '◈',
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
    // BOM source: Roberts, *Engineering Workshop* — saw-pit headrig.
    // 100 kg stone foundation + 100 kg wood frame + 30 kg iron saw = 230 kg.
    placementCost: { stone: 100, wood: 100, iron_ingot: 30 },
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
    // BOM source: Roberts, *Engineering Workshop* — small pot-glass furnace.
    // 200 kg stone firebricks + 40 kg wood frame + 30 kg iron tools + 20 kg clay pots = 290 kg.
    placementCost: { stone: 200, wood: 40, iron_ingot: 30, clay: 20 },
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
    // BOM source: Vernacular civil engineering — salt-pan evaporator tray.
    // 30 kg stone lining + 20 kg wood frame + 10 kg iron brine scoop = 60 kg.
    placementCost: { stone: 30, wood: 20, iron_ingot: 10 },
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
    // BOM source: Daniell-cell + lab-vessel analog.
    // 40 kg stone slab + 20 kg wood frame + 20 kg iron electrodes + 10 kg copper wiring = 90 kg.
    placementCost: { stone: 40, wood: 20, iron_ingot: 20, copper_ingot: 10 },
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
    // BOM source: USDA ARS small-scale bio-reactor reference.
    // 150 kg stone pad + 60 kg wood vat + 40 kg iron stirrer + 30 kg clay seal = 280 kg.
    placementCost: { stone: 150, wood: 60, iron_ingot: 40, clay: 30 },
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
    // BOM source: IspatGuru, "Oil Pump Jack" — beam-balanced nodding-donkey unit.
    // 7000 concrete + 4000 stone + 2000 iron_ingot + 150 gear + 200 copper_ingot = 13.5 t.
    placementCost: { concrete: 7000, stone: 4000, iron_ingot: 2000, gear: 150, copper_ingot: 200 },
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
    // BOM source: IspatGuru, "Gas Wellhead Compressor" — small wellhead dehydration skid.
    // 6000 concrete + 4000 stone + 2000 iron_ingot + 120 gear + 200 copper_ingot = 12.4 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 2000, gear: 120, copper_ingot: 200 },
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
    // §8.7: soft exhaust-scrubber gate (high-emission building).
    gates: [{ matchType: 'def_id', defId: 'exhaust_scrubber', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — steam naphtha cracker furnace + quench tower.
    // 20000 concrete + 12000 stone + 8000 iron_ingot + 400 gear + 5000 clay + 500 copper_ingot = 46.3 t.
    placementCost: { concrete: 20000, stone: 12000, iron_ingot: 8000, gear: 400, clay: 5000, copper_ingot: 500 },
    glyph: '◇',
  },
  // Phase 4 — T2 deep-fraction crude oil cracker (§7.4)
  crude_oil_cracker: {
    id: 'crude_oil_cracker',
    displayName: 'Crude Oil Cracker',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square3,
    fill: 0x2a1a14, // heavy crude black-brown
    stroke: 0x1a0a08,
    power: { consumes: 250 },
    // BOM source: ChemEng. handbook — vacuum distillation crude-oil cracker.
    // 25000 concrete + 15000 stone + 10000 iron_ingot + 500 gear + 6000 clay + 600 copper_ingot = 57.6 t.
    placementCost: { concrete: 25000, stone: 15000, iron_ingot: 10000, gear: 500, clay: 6000, copper_ingot: 600 },
    glyph: '◇',
  },
  // Phase 4 — T2 plastic precursor polymerizer (§7.4)
  plastic_polymerizer_a: {
    id: 'plastic_polymerizer_a',
    displayName: 'Plastic Polymerizer A',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xe0c0a0, // pale polymer beige
    stroke: 0x504030,
    power: { consumes: 120 },
    // BOM source: ChemEng. handbook — batch polymerization reactor vessel.
    // 8000 concrete + 5000 stone + 2000 iron_ingot + 150 gear + 1500 clay + 300 copper_ingot = 17.1 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2000, gear: 150, clay: 1500, copper_ingot: 300 },
    glyph: '◇',
  },
  // Phase 4 — T2 split plastic presses (§7.4)
  rigid_plastic_press: {
    id: 'rigid_plastic_press',
    displayName: 'Rigid Plastic Press',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xc0c0c8, // cool grey plastic
    stroke: 0x505058,
    power: { consumes: 100 },
    // BOM source: Roberts, *Engineering Workshop* — hydraulic rigid-plastic press.
    // 6000 concrete + 4000 stone + 1500 iron_ingot + 100 gear + 200 copper_ingot = 11.9 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 1500, gear: 100, copper_ingot: 200 },
    glyph: '⚙',
  },
  flexible_plastic_press: {
    id: 'flexible_plastic_press',
    displayName: 'Flexible Plastic Press',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xd0b8a0, // warm flexible tan
    stroke: 0x504838,
    power: { consumes: 100 },
    // BOM source: Roberts, *Engineering Workshop* — hydraulic flexible-plastic press.
    // 6000 concrete + 4000 stone + 1500 iron_ingot + 100 gear + 200 copper_ingot = 11.9 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 1500, gear: 100, copper_ingot: 200 },
    glyph: '⚙',
  },
  rubber_synthesizer: {
    id: 'rubber_synthesizer',
    displayName: 'Rubber Synthesizer',
    category: 'manufacturing',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x3a3a30, // dark rubber-grey
    stroke: 0x1a1a10,
    power: { consumes: 100 },
    // BOM source: Roberts, *Engineering Workshop* — rubber vulcanizing press.
    // 6000 concrete + 4000 stone + 1500 iron_ingot + 100 gear + 200 copper_ingot = 11.9 t.
    placementCost: { concrete: 6000, stone: 4000, iron_ingot: 1500, gear: 100, copper_ingot: 200 },
    glyph: '⚙',
  },
  // Phase 5 — T2 chemistry chain (§7.5)
  sulfuric_acid_plant: {
    id: 'sulfuric_acid_plant',
    displayName: 'Sulfuric Acid Plant',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xc0a020, // sulfuric amber
    stroke: 0x504010,
    power: { consumes: 120 },
    // §4.5 Wastewater Treatment soft-gate: chemistry plants run at -50%
    // without an adjacent Wastewater Treatment per §8.7. Same pattern as
    // the Exhaust Scrubber gate on emission-heavy buildings.
    gates: [{ matchType: 'def_id', defId: 'wastewater_treatment', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — contact-process sulfuric-acid plant.
    // 10000 concrete + 6000 stone + 2500 iron_ingot + 150 gear + 2000 clay + 300 copper_ingot = 21.1 t.
    placementCost: { concrete: 10000, stone: 6000, iron_ingot: 2500, gear: 150, clay: 2000, copper_ingot: 300 },
    glyph: '◇',
  },
  hcl_plant: {
    id: 'hcl_plant',
    displayName: 'HCl Plant',
    category: 'chemistry',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0xa0b020, // chlorine-yellow
    stroke: 0x404010,
    power: { consumes: 80 },
    // §4.5 Wastewater Treatment soft-gate.
    gates: [{ matchType: 'def_id', defId: 'wastewater_treatment', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — HCl synthesis burner + absorption tower.
    // 8000 concrete + 5000 stone + 2000 iron_ingot + 120 gear + 1500 clay + 250 copper_ingot = 17.0 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2000, gear: 120, clay: 1500, copper_ingot: 250 },
    glyph: '◇',
  },
  // Phase 5 — T3 chemistry chain (§7.5)
  phosphor_plant: {
    id: 'phosphor_plant',
    displayName: 'Phosphor Plant',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xc06080, // phosphor rose
    stroke: 0x502030,
    power: { consumes: 200 },
    placementCost: { stone: 120, iron_ingot: 40, wood: 15 },
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
    // §4.5 Wastewater Treatment soft-gate.
    gates: [{ matchType: 'def_id', defId: 'wastewater_treatment', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — membrane-cell chlor-alkali plant.
    // 10000 concrete + 6000 stone + 3000 iron_ingot + 200 gear + 2000 clay + 400 copper_ingot = 21.8 t.
    placementCost: { concrete: 10000, stone: 6000, iron_ingot: 3000, gear: 200, clay: 2000, copper_ingot: 400 },
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
    // BOM source: ChemEng. handbook — jacketed stirred-tank chemical reactor.
    // 8000 concrete + 5000 stone + 2000 iron_ingot + 150 gear + 1500 clay + 300 copper_ingot = 17.1 t.
    placementCost: { concrete: 8000, stone: 5000, iron_ingot: 2000, gear: 150, clay: 1500, copper_ingot: 300 },
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
    // §8.7: soft exhaust-scrubber gate (high-emission building).
    gates: [{ matchType: 'def_id', defId: 'exhaust_scrubber', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — lubricant blending + additive injection unit.
    // 12000 concrete + 7000 stone + 4000 iron_ingot + 250 gear + 3000 clay + 350 copper_ingot = 26.9 t.
    placementCost: { concrete: 12000, stone: 7000, iron_ingot: 4000, gear: 250, clay: 3000, copper_ingot: 350 },
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
    // §8.7: soft exhaust-scrubber gate (high-emission building).
    gates: [{ matchType: 'def_id', defId: 'exhaust_scrubber', degradeMul: 0.5 }],
    // BOM source: ChemEng. handbook — hydrocracker diesel hydrotreater.
    // 10000 concrete + 6000 stone + 3000 iron_ingot + 200 gear + 2000 clay + 400 copper_ingot = 21.8 t.
    placementCost: { concrete: 10000, stone: 6000, iron_ingot: 3000, gear: 200, clay: 2000, copper_ingot: 400 },
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
    // BOM source: IspatGuru, "Rod and wire rolling mill" — continuous mill line.
    // 12000 concrete + 7000 stone + 4000 iron_ingot + 250 gear + 2500 clay + 400 copper_ingot = 26.4 t.
    placementCost: { concrete: 12000, stone: 7000, iron_ingot: 4000, gear: 250, clay: 2500, copper_ingot: 400 },
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
    placementCost: { steel: 100, stone: 20 },
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
    // cycle-break (P4C2b): removed steel and microchip per circular-deps
    // invariant. DEVIATION: both were required to make cryo_lab placeable
    // because the cryo deadlock is downstream of the steel SCC; spec §14
    // rebalance owns final tuning.
    placementCost: { stone: 30 },
    glyph: '❄',
  },
  // Phase 5 — T3 cryo air separator (§7.5). Distinct from the existing
  // air_separator which produces gaseous nitrogen; this building liquefies
  // nitrogen for downstream cryogenic recipes.
  cryo_air_separator: {
    id: 'cryo_air_separator',
    displayName: 'Cryo Air Separator',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x80c0d0, // cryo liquid cyan
    stroke: 0x204050,
    power: { consumes: 400 },
    placementCost: { stone: 150, iron_ingot: 60, microchip: 5 },
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
    placementCost: { steel: 200, stone: 40 },
    glyph: '◈',
  },
  // Phase 9 — Task 9.1: Wafer Lab (§7.7). High-purity silicon → wafer.
  wafer_lab: {
    id: 'wafer_lab',
    displayName: 'Wafer Lab',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0xb0b8d0, // pale silica-grey
    stroke: 0x484858,
    power: { consumes: 250 },
    placementCost: { steel: 80, microchip: 5 },
    glyph: '◈',
  },
  // Phase 9 — Task 9.2: Doping Chambers (§7.7). Wafer + graphite → transistor / capacitor / resistor.
  transistor_doping: {
    id: 'transistor_doping',
    displayName: 'Transistor Doping Chamber',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x6080a0, // doping-chamber slate-blue
    stroke: 0x203040,
    power: { consumes: 150 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '◈',
  },
  capacitor_doping: {
    id: 'capacitor_doping',
    displayName: 'Capacitor Doping Chamber',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x6080a0, // doping-chamber slate-blue
    stroke: 0x203040,
    power: { consumes: 150 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '◈',
  },
  resistor_doping: {
    id: 'resistor_doping',
    displayName: 'Resistor Doping Chamber',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x6080a0, // doping-chamber slate-blue
    stroke: 0x203040,
    power: { consumes: 150 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '◈',
  },
  // Phase 9 — Task 9.3: Memory Lab (§7.7). Assembles memory modules from PCB + passives.
  memory_lab: {
    id: 'memory_lab',
    displayName: 'Memory Lab',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x405060, // dark memory-lab slate
    stroke: 0x202830,
    power: { consumes: 250 },
    placementCost: { steel: 100, microchip: 8 },
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

  // Phase 10 — T3 minerals + alloy (Task 10.1)
  mercury_well: {
    id: 'mercury_well',
    displayName: 'Mercury Well',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xc0c0c8, // mercury-silver
    stroke: 0x505058,
    power: { consumes: 80 },
    requiredTile: ['mercury_pit'],
    // BOM source: USGS mercury-extraction pump-stack.
    // 200 steel_beam pump + 150 stone pad + 80 pipe + 30 iron_ingot fittings + 20 wood frame = 720 kg.
    placementCost: { steel_beam: 200, stone: 150, pipe: 80, iron_ingot: 30, wood: 20 },
    glyph: '◌',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.2)
  diamond_quarry: {
    id: 'diamond_quarry',
    displayName: 'Diamond Quarry',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xd0e8f5, // pale ice-blue
    stroke: 0x506070,
    power: { consumes: 100 },
    requiredTile: ['diamond_vein'],
    placementCost: { stone: 80, iron_ingot: 25, wood: 10 },
    glyph: '◆',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.3)
  cryo_compound_lab: {
    id: 'cryo_compound_lab',
    displayName: 'Cryo Compound Lab',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x80c0d0, // cryo teal
    stroke: 0x203840,
    power: { consumes: 300 },
    placementCost: { steel: 100, microchip: 5, glass: 10 },
    glyph: '❄',
  },
  // Phase 10 — T3 minerals + alloy (Task 10.4)
  mag_alloyer: {
    id: 'mag_alloyer',
    displayName: 'Magnetic Alloyer',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x7060a0, // violet-grey magnetic
    stroke: 0x302050,
    power: { consumes: 150 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '◈',
  },
  // Phase 10b — T3 minerals + alloy (Task 10.4.5)
  lithium_extractor: {
    id: 'lithium_extractor',
    displayName: 'Lithium Extractor',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xe04060,
    stroke: 0x701020,
    power: { consumes: 80 },
    requiredTile: ['lithium_vein'],
    placementCost: { stone: 80, iron_ingot: 25, wood: 10 },
    glyph: '⛏',
  },
  // Phase 16.1 — §6.4 uranium extractor (Task 16.1)
  uranium_mine: {
    id: 'uranium_mine',
    displayName: 'Uranium Mine',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x80c060, // yellow-green glow — matches uranium_vein terrain colour
    stroke: 0x304020,
    power: { consumes: 80 },
    requiredTile: ['uranium_vein'],
    placementCost: { stone: 80, iron_ingot: 25, wood: 10 },
    glyph: '☢',
  },
  // Phase 10b — T3 power components (Task 10.5)
  mag_forge: {
    id: 'mag_forge',
    displayName: 'Mag Forge',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x6080a0,
    stroke: 0x203040,
    power: { consumes: 200 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '◈',
  },
  // Phase 10b — T3 power components (Task 10.6)
  motor_assembly: {
    id: 'motor_assembly',
    displayName: 'Motor Assembly',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x507090,
    stroke: 0x182838,
    power: { consumes: 150 },
    placementCost: { steel: 60, microchip: 4 },
    glyph: '⚙',
  },
  // Phase 10b — T3 power components (Task 10.7)
  generator_lab: {
    id: 'generator_lab',
    displayName: 'Generator Lab',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x508070,
    stroke: 0x182820,
    power: { consumes: 180 },
    placementCost: { steel: 80, microchip: 5 },
    glyph: '⚡',
  },
  // Phase 10c — T3 mechanical assemblies (Task 10.8)
  pump_assembly: {
    id: 'pump_assembly',
    displayName: 'Pump Assembly',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x405880,
    stroke: 0x182838,
    power: { consumes: 150 },
    placementCost: { steel: 60, microchip: 4 },
    glyph: '⚙',
  },
  hydraulic_assembly: {
    id: 'hydraulic_assembly',
    displayName: 'Hydraulic Assembly',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x586870,
    stroke: 0x202830,
    power: { consumes: 100 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '⚙',
  },
  pneumatic_assembly: {
    id: 'pneumatic_assembly',
    displayName: 'Pneumatic Assembly',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x506880,
    stroke: 0x182838,
    power: { consumes: 100 },
    placementCost: { steel: 50, microchip: 3 },
    glyph: '⚙',
  },
  // Phase 10c — T3 power components (Task 10.9)
  solar_cell_lab: {
    id: 'solar_cell_lab',
    displayName: 'Solar Cell Lab',
    category: 'electronics',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x405080,
    stroke: 0x182838,
    power: { consumes: 200 },
    placementCost: { steel: 70, microchip: 4 },
    glyph: '◈',
  },
  // Phase 10c — T3 power components (Task 10.10)
  fuel_cell_lab: {
    id: 'fuel_cell_lab',
    displayName: 'Fuel Cell Lab',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x60a080,
    stroke: 0x203828,
    power: { consumes: 200 },
    placementCost: { steel: 70, microchip: 4 },
    glyph: '⚡',
  },
  // Phase 10c — T3 glass/ceramics (Task 10.11)
  optical_glass_kiln: {
    id: 'optical_glass_kiln',
    displayName: 'Optical Glass Kiln',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xc0e0f0,
    stroke: 0x405060,
    power: { consumes: 200 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    placementCost: { steel: 60, microchip: 4 },
    glyph: '△',
  },
  // Phase 10c — T3 fiber spinners (Task 10.12)
  glass_fiber_spinner: {
    id: 'glass_fiber_spinner',
    displayName: 'Glass Fiber Spinner',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xa0c0d8,
    stroke: 0x304050,
    power: { consumes: 150 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    placementCost: { steel: 50, microchip: 3 },
    glyph: '⌇',
  },
  optical_fiber_drawer: {
    id: 'optical_fiber_drawer',
    displayName: 'Optical Fiber Drawer',
    category: 'manufacturing',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0xc0e0f8,
    stroke: 0x405060,
    power: { consumes: 200 },
    requiresHeat: true,
    gates: [{ matchType: 'heat_source', hard: true }],
    placementCost: { steel: 60, microchip: 4 },
    glyph: '⌇',
  },

  // T5 raw extractors (§8.10). Power draws are placeholder "60-100 kW"
  // figures per §8.10 — these are the biggest power loads in the catalog
  // and will brownout most networks until fed Casimir Taps / Singularity
  // Batteries. Multi-output rotation across §6.6 raws now shipped for
  // Aetheric Conduit / Spacetime Resonator / Eldritch Sieve; Zero-Point /
  // Neutronium extractors remain single-output.
  zero_point_extractor: {
    id: 'zero_point_extractor',
    displayName: 'Zero Point Extractor',
    category: 'extraction',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x5a0a4a,
    stroke: 0x200020,
    power: { consumes: 4000 },
    placementCost: { steel: 100, reality_anchor: 30, microchip: 30 },
    glyph: '✦',
  },
  neutronium_extractor: {
    id: 'neutronium_extractor',
    displayName: 'Neutronium Extractor',
    category: 'extraction',
    tier: 5,
    footprint: SHAPES.square2,
    fill: 0x303040,
    stroke: 0x101018,
    power: { consumes: 4000 },
    placementCost: { steel: 100, reality_anchor: 30, microchip: 30 },
    glyph: '✦',
  },
  // Phase 12 — T5 component labs (Task 12.2)
  probability_calculator_lab: {
    id: 'probability_calculator_lab',
    displayName: 'Probability Calculator Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0xa040c0,
    stroke: 0x401060,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  dimensional_fold_lab: {
    id: 'dimensional_fold_lab',
    displayName: 'Dimensional Fold Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x6020a0,
    stroke: 0x201040,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  causal_regulator_lab: {
    id: 'causal_regulator_lab',
    displayName: 'Causal Regulator Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x4080a0,
    stroke: 0x104060,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  // Phase 12 — T5 component labs (Task 12.3)
  tachyonic_transmitter_lab: {
    id: 'tachyonic_transmitter_lab',
    displayName: 'Tachyonic Transmitter Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0xa060c0,
    stroke: 0x401060,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  aether_beacon_lab: {
    id: 'aether_beacon_lab',
    displayName: 'Aether Beacon Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x60a040,
    stroke: 0x204010,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  reality_engine_lab: {
    id: 'reality_engine_lab',
    displayName: 'Reality Engine Lab',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x804060,
    stroke: 0x401030,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
  singularity_battery_factory: {
    id: 'singularity_battery_factory',
    displayName: 'Singularity Battery Factory',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x2a2a48,
    stroke: 0x101020,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '✺',
  },
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
  // Phase 16.2 — §6.6 memetic_core producer (Task 16.2). Closes the
  // memetic_core producer gap: previously memetic_core had no producer.
  memetic_forge: {
    id: 'memetic_forge',
    displayName: 'Memetic Forge',
    category: 'manufacturing',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x802040, // deep crimson — eldritch family
    stroke: 0x300818,
    power: { consumes: 1500 },
    placementCost: { steel: 200, reality_anchor: 50, microchip: 50 },
    glyph: '⌬',
  },
  // -------------------------------------------------------------------------
  // Lighthouse vision (§15.x). Six tiers extending the baseline 10-tile
  // padding ellipse. Vision radius (in tiles) lives in lighthouse.ts →
  // LIGHTHOUSE_VISION_RADII; the economy doesn't read it. Recipes / build
  // costs are STILL-DEFERRED — placement is free pre-§14, and once §14 costs land
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
    // BOM source: Augustin Fresnel 1822 design.
    // 250 stone tower + 100 wood stairs + 30 iron_ingot lantern frame + 10 glass lens + 2 copper_ingot reflector = 392 kg.
    placementCost: { stone: 250, wood: 100, iron_ingot: 30, glass: 10, copper_ingot: 2 },
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
    // BOM source: Pharology mid-20th-c. design.
    // 600 steel_beam tower + 400 stone base + 50 glass lens + 5 microchip beacon + 10 copper_ingot wiring = 1065 kg.
    placementCost: { steel_beam: 600, stone: 400, glass: 50, microchip: 5, copper_ingot: 10 },
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
    // BOM source: USCG Aids to Navigation Manual.
    // 1200 steel_beam tower + 800 concrete base + 100 glass lens + 50 microchip beacon + 20 wire = 2170 kg.
    placementCost: { steel_beam: 1200, concrete: 800, glass: 100, microchip: 50, wire: 20 },
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
    // BOM source: Extrapolated from T3 + exotic finish.
    // 1800 steel_beam tower + 1000 concrete base + 200 glass lens + 200 microchip beacon + 50 wire + 10 exotic_alloy = 3260 kg.
    placementCost: { steel_beam: 1800, concrete: 1000, glass: 200, microchip: 200, wire: 50, exotic_alloy: 10 },
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
    // BOM source: spec-mandate: networked beacon.
    // 2200 steel_beam tower + 1200 concrete base + 250 glass lens + 400 microchip beacon + 20 exotic_alloy + 5 ai_core = ~4 t.
    placementCost: { steel_beam: 2200, concrete: 1200, glass: 250, microchip: 400, exotic_alloy: 20, ai_core: 5 },
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
    // BOM source: spec-mandate: orbital-pulse fitted.
    // 2400 steel_beam tower + 1300 concrete base + 280 glass lens + 500 microchip beacon + 10 ai_core + 2 reality_anchor = 3.8 t.
    placementCost: { steel_beam: 2400, concrete: 1300, glass: 280, microchip: 500, ai_core: 10, reality_anchor: 2 },
    glyph: '⛯',
  },
  // -------------------------------------------------------------------------
  // §11 telemetry — Antenna family. Six tiers extending the drone-scan
  // relay range. Signal radius (in tiles) lives in `antenna.ts →
  // ANTENNA_SIGNAL_RADII`; the economy doesn't read it. Build costs are
  // STILL-DEFERRED to Appendix A.
  //
  //   T1: 1×1, radius 80,  zero-power (basic signal beacon)
  //   T2: 1×1, radius 140, 5 W
  //   T3: 1×1, radius 220, 25 W
  //   T4: 2×2, radius 320, 60 W (comm tower)
  //   T5: 2×2, radius 480, 150 W (exotic signal)
  //   T6: 2×2, radius 700, 400 W (doubles as satellite dish; signal radius adds to ground-station comm range in `groundStationCommRange`)
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
    // BOM source: Vernacular civil engineering — signal mast.
    // 20 kg stone base + 20 kg wood mast + 10 kg iron bracket + 5 kg copper wire = 55 kg.
    placementCost: { stone: 20, wood: 20, iron_ingot: 10, copper_ingot: 5 },
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
    // BOM source: DOT signal mast — small comms antenna tower base.
    // 1500 concrete + 800 stone + 400 iron_ingot + 40 gear + 100 copper_ingot = 2.9 t.
    placementCost: { concrete: 1500, stone: 800, iron_ingot: 400, gear: 40, copper_ingot: 100 },
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
    // Antenna placeholder — tune in Appendix A. T6 antenna also acts as
    // the satellite dish for §14 orbital launches: its signal radius adds
    // to the ground-station comm range of an island with a Spaceport
    // (see `groundStationCommRange` in orbital.ts).
    power: { consumes: 400 },
    placementCost: { antimatter_propellant: 40, steel: 80, reality_anchor: 40 },
    glyph: '⟁',
  },
  // ---------------------------------------------------------------------------
  // Ocean-layer §5 — Sonar Buoy (T2 active depth-discovery building)
  // ---------------------------------------------------------------------------
  //
  // 1×1 ocean-placed building. While the anchor island is powered, marks
  // every cell within `SONAR_BUOY_RADIUS_TILES` of the buoy in BOTH
  // `revealedCells` and `depthRevealedCells`. The reveal tick lives in
  // `sonar-buoy.ts:tickSonarBuoys`, called from main.ts each frame.
  //
  // `oceanPlacement` + `terrainReqs` are declared but not yet enforced —
  // Task 8 wires the ocean placement pipeline. For now this def lives in
  // the catalog so the per-tick reveal logic has a defId to match on.
  //
  // `wire` is the codebase's name for what the spec/plan calls "copper wire";
  // there is no separate `copper_wire` ResourceId.
  //
  // Sonar Buoy placeholder — tune in Appendix A.
  sonar_buoy: {
    id: 'sonar_buoy',
    displayName: 'Sonar Buoy',
    category: 'special',
    tier: 2,
    footprint: SHAPES.single,
    fill: 0x4090a8, // sonar cyan-teal
    stroke: 0x103040,
    power: { consumes: 50 },
    // BOM source: USCG Aids to Navigation Manual — ocean sensor buoy (scaled).
    // 40 steel_beam + 1000 concrete + 200 iron_ingot + 50 wire + 20 microchip = 3.2 t.
    placementCost: { steel_beam: 40, concrete: 1000, iron_ingot: 200, wire: 50, microchip: 20 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep', 'trench', 'hydrothermal_vent', 'nodule_field'],
    glyph: '◌',
  },
  // ---------------------------------------------------------------------------
  // Ocean-layer §3 — Task 8 extractor catalog (5 buildings)
  // ---------------------------------------------------------------------------
  //
  // Each is 2×2 (cell-units; see ocean-cell.ts footprintMatches — for ocean
  // buildings the footprint dimensions index `oceanCells` directly, not the
  // tile grid). Terrain rule per the §3 design-doc catalog table.
  //
  // `wire` is the codebase's name for copper wire (no separate `copper_wire`
  // ResourceId); placement-cost baskets use that. Power consumption + costs
  // are Appendix-A placeholders — tune in balance follow-ups.
  //
  // Anchor picker UI wiring (placement-ui.ts → mountAnchorPicker) is deferred
  // to a follow-up. Until that lands, these defs validate ocean placement at
  // the data layer (validateOceanPlacement in placement.ts) but the regular
  // `validatePlacement` / `placeBuilding` path still routes them onto whatever
  // land tile the user clicks — same forward-compat posture as `sonar_buoy`.
  seawater_intake_rig: {
    id: 'seawater_intake_rig',
    displayName: 'Seawater Intake Rig',
    category: 'extraction',
    tier: 2,
    footprint: SHAPES.square2,
    fill: 0x60a0c0, // shallows blue-grey
    stroke: 0x204060,
    power: { consumes: 200 },
    // BOM source: DOT offshore platform intake riser (scaled).
    // 220 steel_beam + 4000 concrete + 1500 iron_ingot + 120 pipe + 15 microchip = 17.0 t.
    placementCost: { steel_beam: 220, concrete: 4000, iron_ingot: 1500, pipe: 120, microchip: 15 },
    oceanPlacement: true,
    terrainReqs: ['shallows'],
    glyph: '~',
  },
  open_water_extractor: {
    id: 'open_water_extractor',
    displayName: 'Open-Water Extractor',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x4080a0,
    stroke: 0x143048,
    power: { consumes: 400 },
    placementCost: { carbon_steel: 80, wire: 30, microchip: 15 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep'],
    glyph: '≈',
  },
  nodule_harvester: {
    id: 'nodule_harvester',
    displayName: 'Nodule Harvester',
    category: 'extraction',
    tier: 3,
    footprint: SHAPES.square2,
    fill: 0x806040, // nodule brown
    stroke: 0x201810,
    power: { consumes: 600 },
    placementCost: { carbon_steel: 100, gear: 25, microchip: 20 },
    oceanPlacement: true,
    terrainReqs: ['nodule_field'],
    glyph: '⊙',
  },
  trench_drill: {
    id: 'trench_drill',
    displayName: 'Trench Drill',
    category: 'extraction',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0x303048, // trench indigo
    stroke: 0x080814,
    power: { consumes: 1000 },
    placementCost: { exotic_alloy: 5, carbon_steel: 150, ai_core: 1 },
    oceanPlacement: true,
    terrainReqs: ['trench'],
    glyph: '▼',
  },
  vent_tap: {
    id: 'vent_tap',
    displayName: 'Vent Tap',
    category: 'extraction',
    tier: 4,
    footprint: SHAPES.square2,
    fill: 0xc04030, // vent ember red
    stroke: 0x401008,
    power: { consumes: 800 },
    placementCost: { exotic_alloy: 4, carbon_steel: 100, optical_glass: 10 },
    oceanPlacement: true,
    terrainReqs: ['hydrothermal_vent'],
    glyph: '✦',
  },
  // ---------------------------------------------------------------------------
  // Ocean-layer §3 — Task 9 processor catalog (4 chemistry processors + 1
  // passive power source). 3×3 footprints for processors (matches reality
  // _forge / antimatter_refinery T5 chemistry precedent); 2×2 for the
  // Geothermal Vent Generator (mid-density power source on a rare terrain).
  //
  // Categories: 'chemistry' for the processors (the BuildingCategory enum
  // has no 'processing' — these belong with chlor_alkali_plant /
  // sulfuric_acid_plant); 'power' for the generator.
  //
  // No recipe wires through `placementCost` here — costs are §14
  // placeholders; Geothermal Vent Generator's cost mirrors a T6
  // power-source basket (exotic_alloy + ai_core + plasma_containment).
  // ---------------------------------------------------------------------------
  brine_distillation_rig: {
    id: 'brine_distillation_rig',
    displayName: 'Brine Distillation Rig',
    category: 'chemistry',
    tier: 3,
    footprint: SHAPES.square3,
    fill: 0x80b0c0, // pale brine teal
    stroke: 0x204050,
    power: { consumes: 800 },
    placementCost: { carbon_steel: 120, glass: 30, microchip: 20 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep'],
    glyph: '⌒',
  },
  nodule_concentrator: {
    id: 'nodule_concentrator',
    displayName: 'Nodule Concentrator',
    category: 'chemistry',
    tier: 4,
    footprint: SHAPES.square3,
    fill: 0x907858, // concentrator umber
    stroke: 0x201810,
    power: { consumes: 1200 },
    placementCost: { exotic_alloy: 5, carbon_steel: 150, sulfuric_acid: 10 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep'],
    glyph: '◇',
  },
  vent_mineral_refinery: {
    id: 'vent_mineral_refinery',
    displayName: 'Vent Mineral Refinery',
    category: 'chemistry',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0xa040c0, // exotic violet
    stroke: 0x300040,
    power: { consumes: 1500 },
    placementCost: { exotic_alloy: 10, ai_core: 2, casimir_energy: 1 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep'],
    glyph: '◈',
  },
  heavy_water_distiller: {
    id: 'heavy_water_distiller',
    displayName: 'Heavy Water Distiller',
    category: 'chemistry',
    tier: 5,
    footprint: SHAPES.square3,
    fill: 0x6090c0, // distiller cobalt
    stroke: 0x102040,
    power: { consumes: 1200 },
    placementCost: { exotic_alloy: 8, ai_core: 1, optical_glass: 20 },
    oceanPlacement: true,
    terrainReqs: ['shallows', 'deep'],
    glyph: '≋',
  },
  geothermal_vent_generator: {
    id: 'geothermal_vent_generator',
    displayName: 'Geothermal Vent Generator',
    category: 'power',
    tier: 6,
    footprint: SHAPES.square2,
    fill: 0xe05030, // geothermal magma
    stroke: 0x401008,
    // §3 spec literal: ~2 kW passive producer; no consumes, no recipe.
    // Wired into §5.1 power balance via def.power.produces alone, like
    // solar_panel / nuclear_reactor — no per-tick fuel burn.
    power: { produces: 2000 },
    placementCost: { exotic_alloy: 6, ai_core: 1, plasma_containment_vessel: 1 },
    oceanPlacement: true,
    terrainReqs: ['hydrothermal_vent'],
    glyph: '★',
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
    // BOM source: TSMC cleanroom shell (scaled) — PCB etch line enclosure.
    // 180 steel_beam + 5000 concrete + 1000 iron_ingot + 80 gear + 30 microchip + 200 glass = 15.4 t.
    placementCost: { steel_beam: 180, concrete: 5000, iron_ingot: 1000, gear: 80, microchip: 30, glass: 200 },
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
    // BOM source: NOAA ASOS shelter — automated weather station pad + mast.
    // 150 steel_beam + 4000 concrete + 1000 iron_ingot + 60 gear + 20 microchip + 300 glass = 12.9 t.
    placementCost: { steel_beam: 150, concrete: 4000, iron_ingot: 1000, gear: 60, microchip: 20, glass: 300 },
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
