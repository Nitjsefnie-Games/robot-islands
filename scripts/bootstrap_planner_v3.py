#!/usr/bin/env python3
"""Robot Islands — bootstrap build PLANNER (v3, faithful-economy rebuild).

v3 replaces v2's hand-rolled rate model with a FAITHFUL port of the game's
`computeRates` pipeline (src/economy.ts) — "faithful math, no geometry":

  * CATALOG is derived from the game's canonical data (building-defs.ts +
    recipes.ts), verified value-by-value. Logical role names (iron_mine,
    coal_mine, clay_pit, windmill) map to the real defIds (mine / mine /
    clay_pit_extractor / windmill_t0). Scrappers are SYNTHETIC: derived from
    the §6.7 demolition rules (mint = floor(0.3·Σbasket), net-consume =
    n−floor(n/2)) applied to each real building's cost basket.
  * net_rates() ports computeRates passes 1 → 2.5 → 3 → 4:
      - §4.5 cluster bonus  m = 1 + 0.05·(K − (1+L)),  K = Σ(1+L) over the
        same-category cluster.  ALL non-extraction categories cluster
        (whole-island = best-case adjacency).  Extraction does NOT cluster
        (each extractor sits alone on a non-adjacent feature-terrain deposit)
        EXCEPT logger (≤4 fit in a 2×2).
      - §5.2 heat: single-source thermal budget, BOTH sides floor-scaled
        (supply = thermalKW·(1+L_src), demand = heatDemandKW·(1+L_consumer)).
        ASSUMES the issue #114 floor-scaling fix lands in-game (heat.ts reads
        thermalKW raw today). best-case bin-pack across furnaces, no
        aggregation across sources for a single consumer.
      - §15.3 net-flow gate: EXACT 1:1 port of flow-solver.ts solveFlow
        (cap-pinned producers + zero-pinned consumers, SCC ordering +
        shared-factor solve), driven by inventory stock vs storage cap.
      - §5.1 power: joint pf⇄gate fixpoint (flow-power-fixpoint.ts), power
        consumers' whole recipe pre-scaled by pf before the gate solve.
  * Storage caps are category-based (dry/liquid 100, temp 50, components 20,
    rare 1; storageBaseFor = max(5, baseline); crate = generic +5·(1+L)·base).
  * Scrapper rate is CONSTRUCTION-TIME bounded: scrap/s = mint /
    constructionTimeFor(tier).  parallelBuildSlots = 1 at bootstrap, so the
    place+demolish loop is genuinely slow — this honestly surfaces whether the
    scrap bootstrap can mint enough steel_beam to reach the pig-iron crossover.
  * STRATEGY: pig-iron is the PRIMARY sustained steel source (blast_furnace →
    pig_iron → steel_mill).  Scrap (5000 starter cache + scrappers feeding the
    steel_mill_scrap building, which costs NO steel_beam) is a finite,
    transitional bootstrap to mint the first steel_beam needed to PLACE
    blast_furnace + steel_mill.

Control flow is v2's proven skeleton, UNCHANGED in spirit:
  mutate()  — the single state-mutation primitive (sim == commit).
  plan_for()/commit() — simulate a build + its prerequisite fixes, then apply
  the identical action list.  Invariant: after every committed step, every
  resource's net rate is > EPS (gating pins to 0; only true negatives fail).
"""

from math import ceil, floor
import os
import json

SEED_PATH = os.environ.get("RI_SEED")
SEED_MODE = bool(SEED_PATH)

EPS = 1e-9
CLUSTER_RATE = 0.05            # §4.5 CATEGORY_ADJACENCY_RATE (every category)
STOCK_BOUNDARY_EPS = 1e-6      # §15.3 cap/zero classification dust band
PLAN_STEP_CAP = 800
PAYBACK_CAP = 80              # max cost-aware boost steps per plan (the time
                              # optimizer): scale the slowest cost resource's
                              # steady-state root bottleneck while the plan stays
                              # affordable. Bounded so it can't over-build.
PARALLEL_BUILD_SLOTS = 1       # bootstrap: 1 + Robotics(0) + structural(0)
COAL_CYCLE_SEC = 30            # §5.2 furnace fuel-burn cycle
MIN_HEAT_FACTOR = 0.1          # §5.2 below this a heat consumer fully stalls
MIN_PF = 0.5                   # power-provisioning floor: add windmills only to
                               # keep brownout pf >= this (full power front-loads
                               # iron_ingot on windmills and starves the smelter
                               # bootstrap; the game runs fine on partial power)
_FAIL = [""]

# §9.3 base construction time per tier (ms in game → seconds here).
BASE_CONSTRUCTION_S_BY_TIER = {0: 30, 1: 30, 2: 120, 3: 300, 4: 900, 5: 1800, 6: 3600}

# Auto-sizing window: the chain is sized so its steady net production covers the
# whole build's GRASS-good placement demand (notably 55000 steel_beam for the
# blast_furnace + steel_mill apex) within this wall-time.  SMALLER window ⇒ a
# bigger pre-built chain ⇒ the apex bins fill faster ⇒ lower total time — until
# the chain's own (tile-locked) construction cost dominates.  Tuned for the
# <10-year goal.  Tile-locked goods are excluded (their producers are cap-1, so
# amortizing them just explodes the extractor floor); they throttle at runtime.
SIZE_WINDOW_S = 8 * 365 * 24 * 3600

STARTING_INVENTORY = {
    "stone": 1200, "wood": 600, "iron_ore": 30, "coal": 80, "iron_ingot": 60,
    "bolt": 25, "limestone": 15, "saltwater_cell": 4, "foundation_kit": 1,
    "scrap": 5000,
}

# ============================================================================
# CATALOG — verified verbatim from src/building-defs.ts + src/recipes.ts.
# power: +produces / -consumes (kW).  cycle_s: None = no recipe.
# heat_demand_kw: None = boolean heat (needs a source, no thermal cost).
# heat_source: {coal_per_cycle, thermal_kw} for Heat Sources.
# clusters: §4.5 membership (see module docstring).  tier: construction time.
# role->defId notes: iron_mine/coal_mine = `mine` (mine_on_ore/mine_on_coal);
# clay_pit = clay_pit_extractor; windmill = windmill_t0.
# ============================================================================
BUILDINGS = {
    # --- extraction (NOT clustered, except logger) ---
    "logger":     {"cost": {"stone": 30, "wood": 30, "iron_ingot": 10}, "power": 0,
                   "cycle_s": 1404.1, "in": {}, "out": {"wood": 1},
                   "category": "extraction", "clusters": True, "tier": 1},
    "iron_mine":  {"cost": {"stone": 200, "wood": 80}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"iron_ore": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "coal_mine":  {"cost": {"stone": 200, "wood": 80}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"coal": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "quarry":     {"cost": {"stone": 120, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"stone": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "quartz_mine": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"quartz": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "clay_pit":   {"cost": {"stone": 140, "wood": 80}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"clay": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "limestone_quarry": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"limestone": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "copper_mine": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"copper_ore": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "sand_pit":   {"cost": {"stone": 120, "wood": 80, "iron_ingot": 20}, "power": -20,
                   "cycle_s": 40, "in": {}, "out": {"sand": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "well":       {"cost": {"stone": 20, "wood": 20, "iron_ingot": 5}, "power": -10,
                   "cycle_s": 16.4, "in": {}, "out": {"fresh_water": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    "coastal_pump": {"cost": {"stone": 30, "wood": 20, "iron_ingot": 10}, "power": -15,
                   "cycle_s": 16.4, "in": {}, "out": {"saltwater": 1},
                   "category": "extraction", "clusters": False, "tier": 1},
    # --- power (clustered) ---
    "windmill":   {"cost": {"wood": 80, "stone": 20, "iron_ingot": 3}, "power": 15,
                   "cycle_s": None, "in": {}, "out": {},
                   "category": "power", "clusters": True, "tier": 1},
    # --- smelting (clustered) ---
    "smelter":    {"cost": {"stone": 400, "clay": 100, "wood": 20}, "power": -50,
                   "cycle_s": 2981.3, "in": {"iron_ore": 10, "coal": 3},
                   "out": {"iron_ingot": 6, "slag": 2, "co": 5},
                   "category": "smelting", "clusters": True, "tier": 1},
    "copper_smelter": {"cost": {"stone": 200, "iron_ingot": 80, "wood": 30, "clay": 40},
                   "power": -50, "cycle_s": 2774.2, "in": {"copper_ore": 1, "coal": 1},
                   "out": {"copper_ingot": 1}, "category": "smelting", "clusters": True, "tier": 1},
    "coke_oven":  {"cost": {"clay": 15000, "stone": 500, "pipe": 100}, "power": -60,
                   "cycle_s": 214998.3, "in": {"coal": 10},
                   "out": {"coke": 7, "wood_tar": 0.4, "hydrogen": 0.5, "co2": 1,
                           "refinery_gas": 1.1}, "category": "smelting",
                   "clusters": True, "tier": 2, "requiresHeat": True, "heat_demand_kw": 60,
                   "soft_gate": "exhaust_scrubber"},   # §8.7 soft gate (×0.5 if absent)
    "blast_furnace": {"cost": {"steel_beam": 30000, "clay": 25000, "stone": 2000},
                   "power": -100, "cycle_s": 6217.4,
                   "in": {"iron_ore": 35, "coke": 18, "limestone": 10},
                   "out": {"pig_iron": 20, "slag": 6, "co2": 35},
                   "category": "smelting", "clusters": True, "tier": 2,
                   "requiresHeat": True, "heat_demand_kw": 3000},
    "steel_mill": {"cost": {"steel_beam": 25000, "clay": 8000, "stone": 2000},
                   "power": -120, "cycle_s": 4222.6,
                   "in": {"pig_iron": 100, "quicklime": 7, "oxygen": 9},
                   "out": {"steel": 85, "slag": 23, "co": 7, "co2": 1},
                   "category": "smelting", "clusters": True, "tier": 2},  # NO requiresHeat (game)
    "steel_mill_scrap": {"cost": {"concrete": 20000, "stone": 15000, "iron_ingot": 8000,
                            "gear": 500, "clay": 5000, "copper_ingot": 500}, "power": -120,
                   "cycle_s": 72.8, "in": {"scrap": 2}, "out": {"steel": 1, "slag": 1},
                   "category": "smelting", "clusters": True, "tier": 2},
    # --- chemistry (clustered) ---
    "brick_kiln": {"cost": {"stone": 200, "wood": 40, "iron_ingot": 20, "clay": 60},
                   "power": -50, "cycle_s": 64499.5, "in": {"clay": 6},
                   "out": {"brick": 5, "water_vapor": 1}, "category": "chemistry",
                   "clusters": True, "tier": 1, "requiresHeat": True, "heat_demand_kw": None},
    "limekiln":   {"cost": {"stone": 200, "wood": 40, "iron_ingot": 30, "clay": 50},
                   "power": -60, "cycle_s": 119443.5, "in": {"limestone": 25},
                   "out": {"quicklime": 14, "co2": 11}, "category": "chemistry",
                   "clusters": True, "tier": 1, "requiresHeat": True, "heat_demand_kw": None},
    "cement_mill": {"cost": {"stone": 200, "iron_ingot": 60, "wood": 30}, "power": -80,
                   "cycle_s": 9957.8, "in": {"quicklime": 8, "clay": 2, "sand": 1},
                   "out": {"cement": 11}, "category": "chemistry",
                   "clusters": True, "tier": 1, "requiresHeat": True, "heat_demand_kw": None},
    "concrete_plant": {"cost": {"stone": 150, "iron_ingot": 40, "wood": 40, "clay": 20},
                   "power": -60, "cycle_s": 5431.5,
                   "in": {"cement": 1, "sand": 2, "stone": 3, "fresh_water": 0.5},
                   "out": {"concrete": 6}, "category": "chemistry", "clusters": True, "tier": 1},
    "air_separator": {"cost": {"concrete": 2000, "glass": 400, "copper_ingot": 300,
                            "brick": 800}, "power": -300, "cycle_s": 1960.1,
                   "in": {},  # `air:100` is exogenousFlow 'atmosphere' → free, not from inventory
                   "out": {"nitrogen": 75.5, "oxygen": 23.2, "argon": 1.3},
                   "category": "chemistry", "clusters": True, "tier": 3},
    # --- manufacturing (clustered) ---
    "workshop":   {"cost": {"wood": 150, "stone": 100, "iron_ingot": 30}, "power": -60,
                   "cycle_s": 4300, "in": {"iron_ore": 1, "coal": 1}, "out": {"bolt": 1},
                   "category": "manufacturing", "clusters": True, "tier": 1},
    "glassworks": {"cost": {"stone": 200, "wood": 40, "iron_ingot": 30, "clay": 20}, "power": -80,
                   "cycle_s": 22337.5, "in": {"sand": 1}, "out": {"glass": 1},
                   "category": "manufacturing", "clusters": True, "tier": 1},
    "assembler":  {"cost": {"concrete": 7000, "stone": 4000, "iron_ingot": 2000,
                            "glass": 500, "copper_ingot": 300}, "power": -80,
                   "cycle_s": 573.3, "in": {"iron_ingot": 1, "bolt": 2}, "out": {"gear": 1},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    "beam_mill":  {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 3000,
                            "gear": 200, "clay": 2000, "copper_ingot": 200}, "power": -100,
                   "cycle_s": 36119.7, "in": {"steel": 105},
                   "out": {"steel_beam": 2, "mill_scale": 5},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    "pipe_mill":  {"cost": {"concrete": 10000, "stone": 7000, "iron_ingot": 3500,
                            "gear": 250, "clay": 2500, "copper_ingot": 300}, "power": -100,
                   "cycle_s": 14447.9, "in": {"steel": 42},
                   "out": {"pipe": 10, "mill_scale": 2},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    # --- special / storage (no recipe → clustering moot; not clustered) ---
    "coal_furnace": {"cost": {"stone": 50, "iron_ingot": 20, "wood": 30}, "power": 0,
                   "cycle_s": None, "in": {}, "out": {}, "category": "special",
                   "clusters": False, "tier": 1,
                   "heat_source": {"coal_per_cycle": 1, "thermal_kw": 830}},
    "exhaust_scrubber": {"cost": {"steel_beam": 80, "concrete": 1500, "gear": 30,
                            "pipe": 50, "clay": 500}, "power": -20, "cycle_s": None,
                   "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "wastewater_treatment": {"cost": {"steel_beam": 200, "concrete": 8000, "gear": 100,
                            "pipe": 150, "clay": 2000}, "power": -30, "cycle_s": None,
                   "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    # --- oil + downstream chemistry chain (§8.x) ---
    "pump_jack":  {"cost": {"concrete": 7000, "stone": 4000, "iron_ingot": 2000, "gear": 150,
                            "copper_ingot": 200}, "power": -80, "cycle_s": 430,
                   "in": {}, "out": {"crude_oil": 1},
                   "category": "extraction", "clusters": False, "tier": 2},   # tile: oil_well
    "sulfur_mine": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"sulfur": 1},
                   "category": "extraction", "clusters": False, "tier": 1},   # tile: sulfur_vein
    "evaporator": {"cost": {"stone": 30, "wood": 20, "iron_ingot": 10}, "power": -25,
                   "cycle_s": 19111, "in": {"saltwater": 1}, "out": {"salt": 1},
                   "category": "manufacturing", "clusters": True, "tier": 1},
    "crude_oil_cracker": {"cost": {"concrete": 25000, "stone": 15000, "iron_ingot": 10000,
                            "gear": 500, "clay": 6000, "copper_ingot": 600}, "power": -250,
                   "cycle_s": 81.9, "in": {"crude_oil": 3},
                   "out": {"heavy_oil": 1, "tar": 1, "asphalt": 1},
                   "category": "chemistry", "clusters": True, "tier": 2},
    "chemical_reactor": {"cost": {"concrete": 8000, "stone": 5000, "iron_ingot": 2000,
                            "gear": 150, "clay": 1500, "copper_ingot": 300}, "power": -160,
                   "cycle_s": 2345.4, "in": {"sulfur": 1, "quicklime": 1, "heavy_oil": 1},
                   "out": {"calcium_sulfonate": 3},
                   "category": "chemistry", "clusters": True, "tier": 2},
    "chlor_alkali_plant": {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 3000,
                            "gear": 200, "clay": 2000, "copper_ingot": 400}, "power": -150,
                   "cycle_s": 877193, "in": {"salt": 117, "fresh_water": 36},
                   "out": {"chlorine": 71, "sodium_hydroxide": 80, "hydrogen": 2},
                   "category": "chemistry", "clusters": True, "tier": 2,
                   "soft_gate": "wastewater_treatment"},   # §8.7 soft gate (×0.5 if absent)
    "lubricant_refinery": {"cost": {"concrete": 12000, "stone": 7000, "iron_ingot": 4000,
                            "gear": 250, "clay": 3000, "copper_ingot": 350}, "power": -120,
                   "cycle_s": 614.3, "in": {"heavy_oil": 5, "chlorine": 5, "calcium_sulfonate": 1},
                   "out": {"lubricant": 10},
                   "category": "chemistry", "clusters": True, "tier": 2,
                   "soft_gate": "exhaust_scrubber"},      # §8.7 soft gate (×0.5 if absent)
    # --- biofuel + infrastructure (no-recipe placeables) ---
    "biofuel_plant": {"cost": {"stone": 150, "wood": 60, "iron_ingot": 40, "clay": 30},
                   "power": -60, "cycle_s": 358.3, "in": {"wood": 2}, "out": {"biofuel": 1},
                   "category": "chemistry", "clusters": True, "tier": 1},
    "antenna_t2": {"cost": {"concrete": 1500, "stone": 800, "iron_ingot": 400, "gear": 40,
                            "copper_ingot": 100}, "power": -5, "cycle_s": None,
                   "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "dronepad":   {"cost": {"concrete": 2000, "stone": 1000, "iron_ingot": 500, "gear": 100},
                   "power": 0, "cycle_s": None, "in": {}, "out": {},
                   "category": "logistics", "clusters": False, "tier": 2},
    "lighthouse_t1": {"cost": {"stone": 250, "wood": 100, "iron_ingot": 30, "glass": 10,
                            "copper_ingot": 2}, "power": 0, "cycle_s": None, "in": {}, "out": {},
                   "category": "special", "clusters": False, "tier": 1},
    "kit_assembler": {"cost": {"stone": 150, "wood": 60, "iron_ingot": 40, "bolt": 200},
                   "power": -70, "cycle_s": 28666.4,
                   "in": {"iron_ingot": 5, "wood": 10, "bolt": 5}, "out": {"foundation_kit": 1},
                   "category": "manufacturing", "clusters": True, "tier": 1},
    "slag_reprocessor": {"cost": {"concrete": 8000, "stone": 6000, "iron_ingot": 2000,
                            "gear": 300, "copper_ingot": 400}, "power": -100, "cycle_s": 8322.5,
                   "in": {"slag": 10}, "out": {"gold_ore": 1, "silver_ore": 1, "rare_earth": 1},
                   "category": "smelting", "clusters": True, "tier": 2},
    "silicon_crusher": {"cost": {"steel_beam": 350, "concrete": 5000, "gear": 100,
                            "pipe": 50, "stone": 300}, "power": -250, "cycle_s": 2774.2,
                   "in": {"quartz": 1}, "out": {"silicon": 1},
                   "category": "smelting", "clusters": True, "tier": 3},
    "lime_slaker": {"cost": {"stone": 150, "wood": 30, "iron_ingot": 20}, "power": -60,
                   "cycle_s": 905.3, "in": {"quicklime": 1, "fresh_water": 1},
                   "out": {"slaked_lime": 1}, "category": "chemistry", "clusters": True, "tier": 1},
    "mortar_mixer": {"cost": {"stone": 150, "wood": 30, "iron_ingot": 20}, "power": -30,
                   "cycle_s": 905.3, "in": {"sand": 1, "quicklime": 1},
                   "out": {"mortar": 1}, "category": "chemistry", "clusters": True, "tier": 1},
    "naphtha_cracker": {"cost": {"concrete": 20000, "stone": 12000, "iron_ingot": 8000,
                            "gear": 400, "clay": 5000, "copper_ingot": 500}, "power": -200,
                   "cycle_s": 546, "in": {"crude_oil": 20},
                   "out": {"naphtha": 3, "aviation_kerosene_crude": 3, "diesel": 5,
                           "heavy_oil": 6, "refinery_gas": 3},
                   "category": "chemistry", "clusters": True, "tier": 2,
                   "soft_gate": "exhaust_scrubber"},   # §8.7 soft gate (×0.5 if absent)
    "sulfuric_acid_plant": {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 2500,
                            "gear": 150, "clay": 2000, "copper_ingot": 300}, "power": -120,
                   "cycle_s": 1438.5, "in": {"sulfur": 1, "fresh_water": 2},
                   "out": {"sulfuric_acid": 1}, "category": "chemistry", "clusters": True,
                   "tier": 2, "soft_gate": "wastewater_treatment"},
    "hcl_plant":  {"cost": {"concrete": 8000, "stone": 5000, "iron_ingot": 2000, "gear": 120,
                            "clay": 1500, "copper_ingot": 250}, "power": -80, "cycle_s": 930.4,
                   "in": {"salt": 1, "sulfuric_acid": 1}, "out": {"hydrochloric_acid": 1},
                   "category": "chemistry", "clusters": True, "tier": 2,
                   "soft_gate": "wastewater_treatment"},
    "bearing_assembler": {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 3000,
                            "gear": 200, "clay": 2000, "copper_ingot": 300}, "power": -60,
                   "cycle_s": 2665978.7, "in": {"steel": 28, "lubricant": 3},
                   "out": {"bearing": 100, "mill_scale": 1},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    "metal_rolling_mill": {"cost": {"concrete": 12000, "stone": 7000, "iron_ingot": 4000,
                            "gear": 250, "clay": 2500, "copper_ingot": 400}, "power": -200,
                   "cycle_s": 3784, "in": {"steel": 11}, "out": {"wire": 20, "mill_scale": 1},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    "spring_press": {"cost": {"concrete": 8000, "stone": 5000, "iron_ingot": 2500, "gear": 150,
                            "clay": 1500, "copper_ingot": 250}, "power": -60, "cycle_s": 945992.4,
                   "in": {"steel": 11}, "out": {"spring": 50, "mill_scale": 1},
                   "category": "manufacturing", "clusters": True, "tier": 2},
    "charcoal_kiln": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 20}, "power": -40, "cycle_s": 171998.6, "in": {"wood": 8}, "out": {"charcoal": 2, "wood_tar": 1, "co2": 2, "water_vapor": 3}, "category": "chemistry", "clusters": True, "tier": 1, "requiresHeat": True, "heat_demand_kw": None},
    "electrolyzer": {"cost": {"stone": 40, "wood": 20, "iron_ingot": 20, "copper_ingot": 10}, "power": -100, "cycle_s": 206398.3, "in": {"fresh_water": 9}, "out": {"hydrogen": 1, "oxygen": 8}, "category": "chemistry", "clusters": True, "tier": 1},
    "diesel_refinery": {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 3000, "gear": 200, "clay": 2000, "copper_ingot": 400}, "power": -180, "cycle_s": 626.6, "in": {"heavy_oil": 10, "hydrogen": 1}, "out": {"diesel": 10, "sulfur": 0.2}, "category": "chemistry", "clusters": True, "tier": 2, "soft_gate": "exhaust_scrubber"},
    "plastic_polymerizer_a": {"cost": {"concrete": 8000, "stone": 5000, "iron_ingot": 2000, "gear": 150, "clay": 1500, "copper_ingot": 300}, "power": -120, "cycle_s": 358.3, "in": {"naphtha": 1}, "out": {"plastic_precursor": 1}, "category": "chemistry", "clusters": True, "tier": 2},
    "lithography_lab": {"cost": {"steel_beam": 1500, "concrete": 20000, "glass": 500, "wire": 200}, "power": -600, "cycle_s": 67187.0, "in": {"silicon": 1, "wire": 1}, "out": {"microchip": 1}, "category": "electronics", "clusters": True, "tier": 3},
    "cell_press": {"cost": {"copper_ingot": 10, "iron_ingot": 2, "saltwater": 5, "wood": 1}, "power": -20, "cycle_s": 537495.7, "in": {"saltwater": 1, "iron_ingot": 1, "wire": 1}, "out": {"saltwater_cell": 1}, "category": "manufacturing", "clusters": True, "tier": 1},
    "ceramic_kiln": {"cost": {"concrete": 5000, "stone": 4000, "iron_ingot": 1200, "gear": 80, "clay": 2000}, "power": -80, "cycle_s": 10749.9, "in": {"clay": 2, "sand": 1}, "out": {"ceramic_insulator": 1}, "category": "manufacturing", "clusters": True, "tier": 2, "requiresHeat": True, "heat_demand_kw": None},
    "coolant_synthesizer": {"cost": {"concrete": 6000, "stone": 4000, "iron_ingot": 1500, "gear": 150, "glass": 300, "copper_ingot": 200}, "power": -100, "cycle_s": 716.7, "in": {"fresh_water": 2, "salt": 1, "naphtha": 1}, "out": {"coolant": 2}, "category": "manufacturing", "clusters": True, "tier": 2},
    "glass_panel_press": {"cost": {"concrete": 5000, "stone": 3000, "iron_ingot": 1500, "gear": 100, "clay": 1000}, "power": -60, "cycle_s": 67012.5, "in": {"glass": 2}, "out": {"glass_panel": 1}, "category": "manufacturing", "clusters": True, "tier": 2},
    "lumber_mill": {"cost": {"stone": 100, "wood": 100, "iron_ingot": 30}, "power": -40, "cycle_s": 85999.3, "in": {"wood": 1}, "out": {"lumber": 1}, "category": "manufacturing", "clusters": True, "tier": 1},
    "cable_mill": {"cost": {"concrete": 9000, "stone": 6000, "iron_ingot": 2800, "gear": 180, "clay": 2000, "copper_ingot": 400}, "power": -80, "cycle_s": 14447.9, "in": {"steel": 42}, "out": {"heavy_cable": 5, "mill_scale": 2}, "category": "manufacturing", "clusters": True, "tier": 2},
    "biomass_plant": {"cost": {"steel_beam": 400, "clay": 150, "stone": 100, "pipe": 30, "wood": 80}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": False, "tier": 1},
    "dock": {"cost": {"stone": 150, "wood": 100, "iron_ingot": 30}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 1},
    "helipad": {"cost": {"stone": 200, "wood": 60, "iron_ingot": 60}, "power": -60, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 1},
    "shipyard": {"cost": {"stone": 400, "wood": 250, "iron_ingot": 100}, "power": -80, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 1},
    "signal_exchange": {"cost": {"wood": 40, "stone": 20}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 1},
    "geothermal_vent": {"cost": {"stone": 200, "iron_ingot": 80, "wood": 30}, "power": 1000, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": True, "tier": 1},
    "newcomen_engine": {"cost": {"stone": 200, "iron_ingot": 80, "copper_ingot": 40, "wood": 30, "bolt": 5}, "power": 4, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": True, "tier": 1},
    "water_wheel": {"cost": {"wood": 50, "stone": 30, "iron_ingot": 5}, "power": 20, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": True, "tier": 0},
    "antenna_t1": {"cost": {"stone": 20, "wood": 20, "iron_ingot": 10, "copper_ingot": 5}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 1},
    "cooling_tower": {"cost": {"steel_beam": 250, "concrete": 6000, "gear": 80, "pipe": 120, "glass": 300}, "power": -40, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "land_reclamation_hub": {"cost": {"concrete": 15000, "stone": 10000, "iron_ingot": 5000, "gear": 400, "clay": 3000}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "component_warehouse": {"cost": {"steel_beam": 160, "concrete": 2000, "stone": 800, "iron_ingot": 500, "gear": 150, "copper_ingot": 200}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 2},
    "silo": {"cost": {"steel": 5500, "stone": 1500, "iron_ingot": 200}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 1},
    "tank": {"cost": {"steel": 8000, "concrete": 3000, "stone": 1000, "gear": 200, "pipe": 300}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 2},
    "sheet_metal_mill": {"cost": {"concrete": 12000, "stone": 8000, "iron_ingot": 4000, "gear": 300, "clay": 3000}, "power": -100, "cycle_s": 18231.9, "in": {"steel": 53}, "out": {"sheet_metal": 10, "mill_scale": 3}, "category": "manufacturing", "clusters": True, "tier": 2},
    "plant_a_tree": {"cost": {"wood": 5, "fresh_water": 1}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 1},
    "electric_arc_furnace": {"cost": {"steel_beam": 1200, "concrete": 15000, "ceramic_insulator": 500, "gear": 200, "pipe": 200, "microchip": 80}, "power": -10000, "cycle_s": 8908.6, "in": {"scrap": 100, "quicklime": 3}, "out": {"steel": 95, "slag": 5, "co2": 1}, "category": "smelting", "clusters": True, "tier": 3},
    "oxygen_converter": {"cost": {"steel_beam": 1000, "concrete": 10000, "pipe": 300, "gear": 200, "microchip": 50}, "power": -40, "cycle_s": 163.8, "in": {"pig_iron": 1, "scrap": 1, "oxygen": 2}, "out": {"steel": 2}, "category": "smelting", "clusters": True, "tier": 3, "requiresHeat": True, "heat_demand_kw": None},
    "carbon_forge": {"cost": {"steel_beam": 2000, "concrete": 1000, "ceramic_insulator": 500, "microchip": 300, "glass": 200, "pipe": 200, "wire": 100, "coolant": 100}, "power": -700, "cycle_s": 1528.9, "in": {"wood": 5, "coke": 2}, "out": {"carbon_fiber": 1}, "category": "smelting", "clusters": True, "tier": 4, "requiresHeat": True, "heat_demand_kw": 150},
    "mag_alloyer": {"cost": {"steel_beam": 500, "concrete": 6000, "ceramic_insulator": 200, "pipe": 100, "microchip": 50}, "power": -150, "cycle_s": 2774.2, "in": {"iron_ingot": 2, "rare_earth": 1}, "out": {"magnetic_alloy": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "pcb_etcher": {"cost": {"steel_beam": 180, "concrete": 5000, "iron_ingot": 1000, "gear": 80, "microchip": 30, "glass": 200}, "power": -80, "cycle_s": 49142.5, "in": {"wire": 1, "glass": 1}, "out": {"pcb": 1}, "category": "electronics", "clusters": True, "tier": 2},
    "wafer_lab": {"cost": {"steel_beam": 800, "concrete": 12000, "glass": 300, "microchip": 100, "wire": 150}, "power": -250, "cycle_s": 155276.5, "in": {"silicon": 1}, "out": {"silicon_wafer": 1}, "category": "electronics", "clusters": True, "tier": 3},
    "flexible_plastic_press": {"cost": {"concrete": 6000, "stone": 4000, "iron_ingot": 1500, "gear": 100, "copper_ingot": 200}, "power": -100, "cycle_s": 358.3, "in": {"plastic_precursor": 1}, "out": {"flexible_plastic": 1}, "category": "manufacturing", "clusters": True, "tier": 2},
    "rigid_plastic_press": {"cost": {"concrete": 6000, "stone": 4000, "iron_ingot": 1500, "gear": 100, "copper_ingot": 200}, "power": -100, "cycle_s": 358.3, "in": {"plastic_precursor": 1}, "out": {"rigid_plastic": 1}, "category": "manufacturing", "clusters": True, "tier": 2},
    "rubber_synthesizer": {"cost": {"concrete": 6000, "stone": 4000, "iron_ingot": 1500, "gear": 100, "copper_ingot": 200}, "power": -100, "cycle_s": 358.3, "in": {"plastic_precursor": 1}, "out": {"synthetic_rubber": 1}, "category": "manufacturing", "clusters": True, "tier": 2},
    "glass_fiber_spinner": {"cost": {"steel_beam": 350, "concrete": 5000, "ceramic_insulator": 250, "pipe": 80, "microchip": 50}, "power": -200, "cycle_s": 67012.5, "in": {"glass": 2}, "out": {"glass_fiber": 3}, "category": "manufacturing", "clusters": True, "tier": 3, "requiresHeat": True, "heat_demand_kw": None},
    "optical_glass_kiln": {"cost": {"steel_beam": 400, "concrete": 6000, "ceramic_insulator": 300, "pipe": 80, "microchip": 60}, "power": -200, "cycle_s": 10749.9, "in": {"quartz": 2}, "out": {"optical_glass": 1}, "category": "manufacturing", "clusters": True, "tier": 3, "requiresHeat": True, "heat_demand_kw": None},
    "plank_mill": {"cost": {"stone": 100, "wood": 80, "iron_ingot": 20}, "power": -30, "cycle_s": 171998.6, "in": {"lumber": 1}, "out": {"plank": 2}, "category": "manufacturing", "clusters": True, "tier": 1},
    "kit_assembler_enriched": {"cost": {"steel_beam": 800, "concrete": 12000, "gear": 300, "microchip": 80, "bolt": 300}, "power": -150, "cycle_s": 85999.3, "in": {"steel": 5, "microchip": 1, "wire": 5, "gear": 5}, "out": {"foundation_kit_enriched": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "hydraulic_assembly": {"cost": {"steel_beam": 350, "concrete": 4500, "gear": 100, "pipe": 80, "microchip": 50}, "power": -100, "cycle_s": 4300.0, "in": {"pipe": 2, "lubricant": 2, "bearing": 1, "spring": 1}, "out": {"hydraulic_actuator": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "pneumatic_assembly": {"cost": {"steel_beam": 300, "concrete": 4000, "gear": 80, "pipe": 80, "microchip": 50}, "power": -100, "cycle_s": 2866.6, "in": {"pipe": 2, "bearing": 1, "spring": 1}, "out": {"pneumatic_actuator": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "kerosene_refinery": {"cost": {"steel_beam": 1000, "concrete": 18000, "pipe": 500, "gear": 150, "microchip": 100}, "power": -350, "cycle_s": 273.0, "in": {"aviation_kerosene_crude": 10, "hydrogen": 1}, "out": {"aviation_kerosene": 10}, "category": "chemistry", "clusters": True, "tier": 3},
    "cryo_air_separator": {"cost": {"steel_beam": 800, "concrete": 15000, "ceramic_insulator": 400, "pipe": 200, "microchip": 100}, "power": -400, "cycle_s": 19.6, "in": {"nitrogen": 1}, "out": {"liquid_nitrogen": 1}, "category": "chemistry", "clusters": True, "tier": 3},
    "cryo_lab": {"cost": {"steel_beam": 600, "concrete": 15000, "ceramic_insulator": 300, "pipe": 150, "microchip": 80}, "power": -400, "cycle_s": 19.6, "in": {"hydrogen": 1, "nitrogen": 1}, "out": {"cryo_coolant": 1}, "category": "chemistry", "clusters": True, "tier": 3},
    "bulk_concrete_plant": {"cost": {"steel": 8000, "stone": 2000, "microchip": 500, "pipe": 500, "gear": 200, "wire": 100}, "power": -2000, "cycle_s": 60.0, "in": {"cement": 50, "sand": 100, "stone": 50, "fresh_water": 25}, "out": {"concrete": 100}, "category": "manufacturing", "clusters": True, "tier": 6},
    "airship_dock": {"cost": {"steel_beam": 1200, "concrete": 20000, "gear": 200, "glass": 200, "microchip": 50, "wire": 100}, "power": -150, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 3},
    "patron_hub": {"cost": {"steel_beam": 400, "concrete": 6000, "glass": 250, "microchip": 50, "wire": 120}, "power": -100, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 3},
    "power_substation": {"cost": {"steel_beam": 600, "concrete": 800, "copper_ingot": 400, "microchip": 100, "wire": 200, "ceramic_insulator": 200, "heavy_cable": 100}, "power": -60, "cycle_s": None, "in": {}, "out": {}, "category": "logistics", "clusters": False, "tier": 4},
    "sunspire": {"cost": {"steel_beam": 8000, "glass": 4000, "stone": 1000, "microchip": 200, "coolant": 100}, "power": 60000, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": True, "tier": 4},
    "antenna_t3": {"cost": {"steel_beam": 80, "concrete": 1200, "microchip": 30, "wire": 60}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 3},
    "antenna_t4": {"cost": {"steel_beam": 600, "concrete": 800, "microchip": 100, "glass": 100, "wire": 100, "ceramic_insulator": 100}, "power": -60, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 4},
    "lighthouse_t2": {"cost": {"steel_beam": 600, "stone": 400, "glass": 50, "microchip": 5, "copper_ingot": 10}, "power": -10, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "lighthouse_t3": {"cost": {"steel_beam": 1200, "concrete": 800, "glass": 100, "microchip": 50, "wire": 20}, "power": -25, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 3},
    "launch_tower": {"cost": {"steel_beam": 2500, "concrete": 1500, "microchip": 200, "glass": 200, "wire": 100, "pipe": 100, "gear": 50}, "power": -400, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 4},
    "orbital_tracking_station": {"cost": {"steel_beam": 1200, "concrete": 3000, "microchip": 300, "glass": 300, "wire": 400, "ceramic_insulator": 300}, "power": -80, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 6},
    "plasma_heater": {"cost": {"steel_beam": 1500, "concrete": 12000, "ceramic_insulator": 400, "pipe": 200, "microchip": 80}, "power": -200, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 3},
    "platform_constructor": {"cost": {"steel_beam": 2000, "concrete": 25000, "stone": 500, "microchip": 150, "wire": 300}, "power": -200, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 3},
    "sonar_buoy": {"cost": {"steel_beam": 40, "concrete": 1000, "iron_ingot": 200, "wire": 50, "microchip": 20}, "power": -50, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "terrain_modifier": {"cost": {"steel_beam": 200, "concrete": 5000, "gear": 100, "pipe": 80, "microchip": 10}, "power": -100, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "weather_station_t2": {"cost": {"steel_beam": 150, "concrete": 4000, "iron_ingot": 1000, "gear": 60, "microchip": 20, "glass": 300}, "power": -10, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 2},
    "advanced_weather_station_t3": {"cost": {"steel_beam": 350, "concrete": 4500, "glass": 250, "microchip": 40, "wire": 80}, "power": -25, "cycle_s": None, "in": {}, "out": {}, "category": "special", "clusters": False, "tier": 3},
    "cold_storage": {"cost": {"steel_beam": 200, "concrete": 3000, "stone": 1000, "copper_ingot": 500, "gear": 200, "microchip": 100}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 2},
    "vault": {"cost": {"steel_beam": 1200, "concrete": 15000, "stone": 500, "microchip": 200, "wire": 400}, "power": 0, "cycle_s": None, "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 3},
    "coal_gen": {"cost": {"steel_beam": 500, "clay": 200, "stone": 100, "pipe": 50, "microchip": 10}, "power": 5000, "cycle_s": None, "in": {}, "out": {}, "category": "power", "clusters": True, "tier": 1},
    "cryo_compound_lab": {"cost": {"steel_beam": 700, "concrete": 10000, "ceramic_insulator": 250, "pipe": 150, "microchip": 80}, "power": -300, "cycle_s": 19.6, "in": {"liquid_nitrogen": 1, "cryo_coolant": 1}, "out": {"cryogenic_compound": 1}, "category": "chemistry", "clusters": True, "tier": 3},
    "cryo_compressor": {"cost": {"steel_beam": 700, "concrete": 10000, "ceramic_insulator": 250, "pipe": 200, "microchip": 80}, "power": -500, "cycle_s": 19.6, "in": {"hydrogen": 1, "cryo_coolant": 1}, "out": {"cryogenic_hydrogen": 1}, "category": "chemistry", "clusters": True, "tier": 3},
    "circuit_assembler": {"cost": {"steel_beam": 350, "concrete": 4500, "microchip": 50, "wire": 100, "gear": 70, "glass": 60}, "power": -30, "cycle_s": 143.3, "in": {"pcb": 1, "microchip": 2, "steel": 1}, "out": {"circuit_board": 1}, "category": "electronics", "clusters": True, "tier": 3},
    "quantum_chip_fab": {"cost": {"steel_beam": 8000, "glass": 4000, "microchip": 2000, "ceramic_insulator": 1000, "silicon_wafer": 200}, "power": -1500, "cycle_s": 3822191.6, "in": {"steel": 4, "pig_iron": 4}, "out": {"quantum_chip": 1}, "category": "electronics", "clusters": True, "tier": 4},
    "fuel_cell_lab": {"cost": {"steel_beam": 600, "concrete": 8000, "ceramic_insulator": 250, "pipe": 100, "microchip": 70}, "power": -200, "cycle_s": 1433.3, "in": {"hydrogen": 2, "rare_earth": 1, "flexible_plastic": 1}, "out": {"fuel_cell": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "mag_forge": {"cost": {"steel_beam": 600, "concrete": 7000, "ceramic_insulator": 250, "pipe": 100, "microchip": 60}, "power": -180, "cycle_s": 138708.6, "in": {"magnetic_alloy": 1, "wire": 2}, "out": {"magnet": 1}, "category": "manufacturing", "clusters": True, "tier": 3},
    "optical_fiber_drawer": {"cost": {"steel_beam": 400, "concrete": 6000, "glass": 200, "microchip": 60, "wire": 80}, "power": -200, "cycle_s": 688.0, "in": {"optical_glass": 1}, "out": {"optical_fiber": 2}, "category": "manufacturing", "clusters": True, "tier": 3, "requiresHeat": True, "heat_demand_kw": None},
    "crate":      {"cost": {"wood": 80, "stone": 30}, "power": 0, "cycle_s": None,
                   "in": {}, "out": {}, "category": "storage", "clusters": False, "tier": 1},
}

# Terrain caps — abstraction for scarce, NON-ADJACENT feature-terrain deposits
# (the game enforces tile-type + overlap, not a count; one extractor per deposit,
# deposits don't touch). logger=4: the only extractor small enough to pack 4 into
# a 2×2 (so 4 loggers form one cluster). Grass buildings: effectively unbounded.
TERRAIN_CAPS = {
    "logger": 4, "iron_mine": 1, "coal_mine": 1, "quarry": 1, "quartz_mine": 1,
    "clay_pit": 1, "limestone_quarry": 1, "copper_mine": 1, "sand_pit": 1,
    "well": 4, "coastal_pump": 4, "pump_jack": 1, "sulfur_mine": 1,
    "evaporator": 999, "crude_oil_cracker": 999, "chemical_reactor": 999,
    "chlor_alkali_plant": 999, "lubricant_refinery": 999, "wastewater_treatment": 999,
    "biofuel_plant": 999, "antenna_t2": 999, "dronepad": 999, "lighthouse_t1": 999,
    "kit_assembler": 999, "slag_reprocessor": 999, "silicon_crusher": 999,
    "lime_slaker": 999, "mortar_mixer": 999, "naphtha_cracker": 999,
    "sulfuric_acid_plant": 999, "hcl_plant": 999, "bearing_assembler": 999, "spring_press": 999,
    "metal_rolling_mill": 999,
    "cryo_compound_lab": 999, "cryo_compressor": 999, "circuit_assembler": 999, "quantum_chip_fab": 999, "fuel_cell_lab": 999, "mag_forge": 999, "optical_fiber_drawer": 999,
    "electric_arc_furnace": 999, "oxygen_converter": 999, "carbon_forge": 999, "mag_alloyer": 999, "pcb_etcher": 999, "wafer_lab": 999, "flexible_plastic_press": 999, "rigid_plastic_press": 999, "rubber_synthesizer": 999, "glass_fiber_spinner": 999, "optical_glass_kiln": 999, "plank_mill": 999, "kit_assembler_enriched": 999, "hydraulic_assembly": 999, "pneumatic_assembly": 999, "kerosene_refinery": 999, "cryo_air_separator": 999, "cryo_lab": 999, "bulk_concrete_plant": 999, "airship_dock": 999, "patron_hub": 999, "power_substation": 999, "sunspire": 999, "antenna_t3": 999, "antenna_t4": 999, "lighthouse_t2": 999, "lighthouse_t3": 999, "launch_tower": 999, "orbital_tracking_station": 999, "plasma_heater": 999, "platform_constructor": 999, "sonar_buoy": 999, "terrain_modifier": 999, "weather_station_t2": 999, "advanced_weather_station_t3": 999, "cold_storage": 999, "vault": 999, "coal_gen": 999,
    "charcoal_kiln": 999, "electrolyzer": 999, "diesel_refinery": 999, "plastic_polymerizer_a": 999, "lithography_lab": 999, "cell_press": 999, "ceramic_kiln": 999, "coolant_synthesizer": 999, "glass_panel_press": 999, "lumber_mill": 999, "cable_mill": 999, "biomass_plant": 999, "dock": 999, "helipad": 999, "shipyard": 999, "signal_exchange": 999, "geothermal_vent": 999, "newcomen_engine": 999, "water_wheel": 999, "antenna_t1": 999, "cooling_tower": 999, "land_reclamation_hub": 999, "component_warehouse": 999, "silo": 999, "tank": 999, "sheet_metal_mill": 999, "plant_a_tree": 999,
    "windmill": 999, "smelter": 999, "copper_smelter": 999, "coke_oven": 999,
    "blast_furnace": 999, "steel_mill": 999, "steel_mill_scrap": 999,
    "brick_kiln": 999, "limekiln": 999, "cement_mill": 999, "concrete_plant": 999,
    "air_separator": 999, "workshop": 999, "glassworks": 999, "assembler": 999,
    "beam_mill": 999, "pipe_mill": 999, "coal_furnace": 999, "exhaust_scrubber": 999,
    "crate": 999,
}

# --- storage caps (verified from src/storage-categories.ts) ---
STORAGE_CAT = {
    "stone": "dry_goods", "wood": "dry_goods", "iron_ingot": "dry_goods",
    "quartz": "dry_goods", "clay": "dry_goods", "iron_ore": "dry_goods",
    "coal": "dry_goods", "slag": "dry_goods", "co": "liquid_gas", "bolt": "components",
    "limestone": "dry_goods", "copper_ore": "dry_goods", "copper_ingot": "dry_goods",
    "sand": "dry_goods", "glass": "dry_goods", "fresh_water": "liquid_gas",
    "saltwater": "liquid_gas", "concrete": "dry_goods", "gear": "components",
    "brick": "dry_goods", "water_vapor": "liquid_gas", "steel": "components",
    "steel_beam": "components", "mill_scale": "dry_goods", "pipe": "components",
    "coke": "dry_goods", "wood_tar": "liquid_gas", "hydrogen": "liquid_gas",
    "co2": "liquid_gas", "refinery_gas": "liquid_gas", "pig_iron": "dry_goods",
    "air": "liquid_gas", "nitrogen": "liquid_gas", "oxygen": "liquid_gas",
    "argon": "liquid_gas", "quicklime": "dry_goods", "cement": "dry_goods",
    "scrap": "dry_goods", "saltwater_cell": "components", "foundation_kit": "components",
    "crude_oil": "liquid_gas", "heavy_oil": "liquid_gas", "tar": "dry_goods",
    "asphalt": "liquid_gas", "salt": "dry_goods", "sulfur": "dry_goods",
    "chlorine": "liquid_gas", "sodium_hydroxide": "liquid_gas",
    "calcium_sulfonate": "dry_goods", "lubricant": "liquid_gas", "biofuel": "liquid_gas",
    "gold_ore": "dry_goods", "silver_ore": "dry_goods", "rare_earth": "dry_goods",
    "silicon": "components", "slaked_lime": "dry_goods", "mortar": "dry_goods",
    "naphtha": "liquid_gas", "aviation_kerosene_crude": "liquid_gas", "diesel": "liquid_gas",
    "sulfuric_acid": "liquid_gas", "hydrochloric_acid": "liquid_gas", "bearing": "components", "spring": "components", "wire": "components",
    "circuit_board": "components", "cryogenic_compound": "temp_sensitive", "cryogenic_hydrogen": "liquid_gas", "fuel_cell": "components", "magnet": "components", "optical_fiber": "components", "quantum_chip": "components",
    "aviation_kerosene": "liquid_gas", "carbon_fiber": "rare", "cryo_coolant": "temp_sensitive", "flexible_plastic": "components", "foundation_kit_enriched": "dry_goods", "glass_fiber": "components", "hydraulic_actuator": "components", "liquid_nitrogen": "temp_sensitive", "magnetic_alloy": "components", "optical_glass": "components", "pcb": "components", "plank": "dry_goods", "pneumatic_actuator": "components", "rigid_plastic": "components", "silicon_wafer": "components", "synthetic_rubber": "components",
    "ceramic_insulator": "components", "charcoal": "dry_goods", "coolant": "liquid_gas", "glass_panel": "components", "heavy_cable": "components", "lumber": "dry_goods", "microchip": "components", "plastic_precursor": "liquid_gas", "sheet_metal": "components",
}
CAT_DEFAULT_CAP = {"dry_goods": 100, "liquid_gas": 100, "temp_sensitive": 50,
                   "components": 20, "rare": 1}
RESOURCE_BASE_CAP = {"helium_3": 1, "antimatter_propellant": 1, "ai_core": 0,
                     "foundation_kit": 5}
MIN_STORAGE_BASE = 5
CRATE_CAPACITY = 5     # crate is generic storage with capacity 5

# --- AUTO scrap faucets (§6.7 demolition recovery on each building's basket) ---
# mint = floor(0.3 · Σ placementCost);  net-consume r = n − floor(n/2);
# rate = mint / constructionTimeFor(tier)  (one place+demolish loop, 1 build slot).
for _base in list(BUILDINGS):
    _cost = BUILDINGS[_base]["cost"]
    _tier = BUILDINGS[_base]["tier"]
    _scrap_out = floor(0.3 * sum(_cost.values()))
    if _scrap_out <= 0:
        continue
    _consumed = {r: n - (n // 2) for r, n in _cost.items() if n - (n // 2) > 0}
    _cycle = BASE_CONSTRUCTION_S_BY_TIER[_tier] / PARALLEL_BUILD_SLOTS
    BUILDINGS[f"{_base}_scrapper"] = {
        "cost": {"fresh_water": 50}, "power": 0, "cycle_s": _cycle,
        "in": _consumed, "out": {"scrap": _scrap_out},
        "category": "special", "clusters": False, "tier": 1, "synthetic": True,
    }
    TERRAIN_CAPS[f"{_base}_scrapper"] = 999

# --- TARGET set (the bootstrap goal; same 27 as v2) ---
TARGET = {
    "logger": 4, "quarry": 1, "quartz_mine": 1, "iron_mine": 1, "coal_mine": 1,
    "clay_pit": 1, "smelter": 1, "workshop": 1, "limestone_quarry": 1,
    "copper_mine": 1, "copper_smelter": 1, "sand_pit": 1, "glassworks": 1,
    "well": 1, "coastal_pump": 1, "limekiln": 1, "cement_mill": 1,
    "concrete_plant": 1, "assembler": 1, "steel_mill_scrap": 3, "brick_kiln": 1,
    "beam_mill": 4, "pipe_mill": 1, "coke_oven": 1, "blast_furnace": 1,
    "air_separator": 1, "steel_mill": 1,
    # §8.x oil + downstream chemistry chain
    "pump_jack": 1, "crude_oil_cracker": 1, "evaporator": 1, "sulfur_mine": 1,
    "chemical_reactor": 1, "chlor_alkali_plant": 1, "lubricant_refinery": 1,
    # biofuel + infrastructure
    "biofuel_plant": 1, "antenna_t2": 1, "dronepad": 1, "lighthouse_t1": 1,
    "kit_assembler": 1, "slag_reprocessor": 1, "silicon_crusher": 1,
    "lime_slaker": 1, "mortar_mixer": 1, "naphtha_cracker": 1,
    "sulfuric_acid_plant": 1, "hcl_plant": 1, "bearing_assembler": 1, "spring_press": 1,
    "metal_rolling_mill": 1,
    "cryo_compound_lab": 1, "cryo_compressor": 1, "circuit_assembler": 1, "quantum_chip_fab": 1, "fuel_cell_lab": 1, "mag_forge": 1, "optical_fiber_drawer": 1,
    "electric_arc_furnace": 1, "oxygen_converter": 1, "carbon_forge": 1, "mag_alloyer": 1, "pcb_etcher": 1, "wafer_lab": 1, "flexible_plastic_press": 1, "rigid_plastic_press": 1, "rubber_synthesizer": 1, "glass_fiber_spinner": 1, "optical_glass_kiln": 1, "plank_mill": 1, "kit_assembler_enriched": 1, "hydraulic_assembly": 1, "pneumatic_assembly": 1, "kerosene_refinery": 1, "cryo_air_separator": 1, "cryo_lab": 1, "bulk_concrete_plant": 1, "airship_dock": 1, "patron_hub": 1, "power_substation": 1, "sunspire": 1, "antenna_t3": 1, "antenna_t4": 1, "lighthouse_t2": 1, "lighthouse_t3": 1, "launch_tower": 1, "orbital_tracking_station": 1, "plasma_heater": 1, "platform_constructor": 1, "sonar_buoy": 1, "terrain_modifier": 1, "weather_station_t2": 1, "advanced_weather_station_t3": 1, "cold_storage": 1, "vault": 1, "coal_gen": 1,
    "charcoal_kiln": 1, "electrolyzer": 1, "diesel_refinery": 1, "plastic_polymerizer_a": 1, "lithography_lab": 1, "cell_press": 1, "ceramic_kiln": 1, "coolant_synthesizer": 1, "glass_panel_press": 1, "lumber_mill": 1, "cable_mill": 1, "biomass_plant": 1, "dock": 1, "helipad": 1, "shipyard": 1, "signal_exchange": 1, "geothermal_vent": 1, "newcomen_engine": 1, "water_wheel": 1, "antenna_t1": 1, "cooling_tower": 1, "land_reclamation_hub": 1, "component_warehouse": 1, "silo": 1, "tank": 1, "sheet_metal_mill": 1, "plant_a_tree": 1,
}

NEEDED_RES = {r for b in BUILDINGS.values()
              for r in list(b["in"]) + list(b["cost"])}

# Tile-locked resources: produced only by extraction (cap < grass) — scaling
# them is exponential, so scrapper selection avoids them (weighted heavily).
GRASS_CAP = 50
PRODUCERS_OF = {}
for _b in BUILDINGS:
    for _r in BUILDINGS[_b]["out"]:
        PRODUCERS_OF.setdefault(_r, []).append(_b)
TILE_LOCKED_RES = {r for r, prods in PRODUCERS_OF.items()
                   if all(TERRAIN_CAPS[p] < GRASS_CAP for p in prods)}

# §4.6 force-run targets. A resource is a PRIMARY product if some building makes
# it as its SOLE output (a dedicated producer — cement, concrete, quicklime,
# salt, gear, bolt, …) OR it is a placement cost we stockpile (steel_beam,
# concrete, iron_ingot, gear, pipe, …). Everything else a building emits is a
# BYPRODUCT (slag, co, co2, mill_scale, water_vapor, gold_ore, NaOH, …) — over-
# produced relative to any minor consumer, so it fills its small cap and would
# cap-gate its whole building to 0, stalling the useful output. A building that
# emits ANY non-primary output is therefore force-run (ignoreOutputCap): it keeps
# running and the byproduct overflow is voided.
#   Why not "never consumed"?  slag_reprocessor lightly consumes slag, but one
# reprocessor can't absorb the whole steel chain's slag — so slag must stay a
# voidable byproduct or steel_mill_scrap (slag its only byproduct) loses force-run
# and the slag cap stalls the steel chain. Dedicated producers (cement_mill,
# limekiln's quicklime, evaporator, …) keep their SOLE useful output un-voided and
# throttle to demand instead of wasting tile-locked inputs.
_PLACEMENT_RES = {r for b in BUILDINGS.values() for r in b["cost"]}
_SOLE_OUTPUT_RES = {next(iter(b["out"])) for b in BUILDINGS.values() if len(b["out"]) == 1}
PRIMARY_RES = _PLACEMENT_RES | _SOLE_OUTPUT_RES
FORCE_RUN = {n for n in BUILDINGS
             if any(r not in PRIMARY_RES for r in BUILDINGS[n]["out"])}

_CATEGORY = {n: BUILDINGS[n]["category"] for n in BUILDINGS}
_CLUSTERED = {n: BUILDINGS[n]["clusters"] for n in BUILDINGS}
_CYCLE = {n: BUILDINGS[n]["cycle_s"] for n in BUILDINGS}


# ====================================================================
# STORAGE CAPS (§4.6 / storage-categories.ts)
# ====================================================================
def baseline_cap(r):
    if r in RESOURCE_BASE_CAP:
        return RESOURCE_BASE_CAP[r]
    return CAT_DEFAULT_CAP.get(STORAGE_CAT.get(r, "dry_goods"), 100)


def storage_base_for(r):
    return max(MIN_STORAGE_BASE, baseline_cap(r))


def nominal_cap(r, crate_for):
    if SEED_MODE:
        return 1e15
    cap = float(baseline_cap(r))
    for L in crate_for.get(r, []):
        cap += CRATE_CAPACITY * (1 + L) * storage_base_for(r)
    return cap


# ====================================================================
# EXACT solveFlow PORT (src/flow-solver.ts)
# ====================================================================
def solve_shared_factor(entries, target):
    """Solve Σ coeff·min(otherGate, θ) = target for the largest θ ∈ [0,1]."""
    live = [(c, o) for (c, o) in entries if c > 0 and o > 0]
    if not live:
        return 1.0
    if target != target:  # NaN → fail open
        return 1.0
    full = sum(c * min(o, 1.0) for c, o in live)
    if full <= target + EPS:
        return 1.0
    if target <= 0:
        return 0.0
    sorted_e = sorted(live, key=lambda e: e[1])
    n = len(sorted_e)
    pinned_sum = 0.0
    free_coeff = sum(c for c, _ in sorted_e)
    lo = 0.0
    for k in range(n + 1):
        hi = min(sorted_e[k][1], 1.0) if k < n else 1.0
        if free_coeff > EPS:
            theta = (target - pinned_sum) / free_coeff
            if theta >= lo - EPS and theta <= hi + EPS:
                return min(1.0, max(0.0, theta))
        if k < n:
            c, o = sorted_e[k]
            pinned_sum += c * min(o, 1.0)
            free_coeff -= c
            lo = hi
            if free_coeff <= 0:
                break
    return 1.0


FLOW_MAX_SWEEPS = 1000


def solve_flow(buildings, cap_constrained, zero_constrained):
    """Return per-building gate g∈[0,1].  buildings: list of dicts with
    'produces'{r:coeff}, 'consumes'{r:coeff}, optional 'ignore_output_cap'."""
    n = len(buildings)
    keys = [("cap", r) for r in cap_constrained] + [("zero", r) for r in zero_constrained]
    if not keys or n == 0:
        return [1.0] * n

    keys_by_building = []
    for b in buildings:
        ks = []
        if not b.get("ignore_output_cap"):
            for r, v in b["produces"].items():
                if v > 0 and r in cap_constrained:
                    ks.append(("cap", r))
        for r, v in b["consumes"].items():
            if v > 0 and r in zero_constrained:
                ks.append(("zero", r))
        keys_by_building.append(ks)

    mul = {k: 1.0 for k in keys}

    def gate(i, exclude=None):
        g = 1.0
        for k in keys_by_building[i]:
            if k == exclude:
                continue
            m = mul.get(k, 1.0)
            if m < g:
                g = m
        return g

    def update(key):
        kind, res = key
        target = 0.0
        entries = []
        if kind == "cap":
            for i, b in enumerate(buildings):
                p = b["produces"].get(res, 0.0)
                c = b["consumes"].get(res, 0.0)
                if p > 0:
                    if b.get("ignore_output_cap"):
                        continue
                    net = p - c
                    if net > 0:
                        entries.append((net, gate(i, key)))
                elif c > 0:
                    target += c * gate(i, key)
        else:
            for i, b in enumerate(buildings):
                p = b["produces"].get(res, 0.0)
                c = b["consumes"].get(res, 0.0)
                if c > 0:
                    net = c - p
                    if net > 0:
                        entries.append((net, gate(i, key)))
                elif p > 0:
                    target += p * gate(i, key)
        return solve_shared_factor(entries, target)

    # dependency graph between keys (ki depends on keys gating ki's participants)
    key_index = {k: i for i, k in enumerate(keys)}
    edges = [[] for _ in keys]
    for ki, key in enumerate(keys):
        _, res = key
        deps = set()
        for i, b in enumerate(buildings):
            if b["produces"].get(res, 0.0) <= 0 and b["consumes"].get(res, 0.0) <= 0:
                continue
            for k2 in keys_by_building[i]:
                if k2 != key:
                    deps.add(key_index[k2])
        edges[ki] = list(deps)

    # Tarjan SCC (iterative-friendly recursion; key counts are small here)
    order = []
    idx = [-1] * len(keys)
    low = [0] * len(keys)
    on_stack = [False] * len(keys)
    stack = []
    counter = [0]

    import sys
    sys.setrecursionlimit(10000)

    def visit(v):
        idx[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        on_stack[v] = True
        for w in edges[v]:
            if idx[w] == -1:
                visit(w)
                low[v] = min(low[v], low[w])
            elif on_stack[w]:
                low[v] = min(low[v], idx[w])
        if low[v] == idx[v]:
            comp = []
            while True:
                w = stack.pop()
                on_stack[w] = False
                comp.append(w)
                if w == v:
                    break
            order.append(comp)

    for v in range(len(keys)):
        if idx[v] == -1:
            visit(v)

    for comp in order:
        if len(comp) == 1:
            k = keys[comp[0]]
            mul[k] = update(k)
            continue
        for ki in comp:
            mul[keys[ki]] = 0.0
        sweeps = 0
        while True:
            max_delta = 0.0
            for ki in comp:
                k = keys[ki]
                prev = mul[k]
                nxt = update(k)
                if sweeps > 100:
                    nxt = (nxt + prev) / 2
                mul[k] = nxt
                max_delta = max(max_delta, abs(nxt - prev))
            sweeps += 1
            if max_delta < EPS:
                break
            if sweeps >= FLOW_MAX_SWEEPS:
                break

    return [gate(i) for i in range(n)]


# ====================================================================
# §4.5 CLUSTER, §5.2 HEAT, §5.1 POWER
# ====================================================================
def cluster_K(placed):
    """K[category] = Σ(1+L) over clustered buildings of that category."""
    K = {}
    for name, floors in placed.items():
        if not floors or not _CLUSTERED.get(name):
            continue
        cat = _CATEGORY[name]
        K[cat] = K.get(cat, 0.0) + sum(1 + f for f in floors)
    return K


def resolve_heat(placed):
    """§5.2 single-source thermal budget, BOTH sides floor-scaled (assumes the
    #114 floor-scaling fix).  Best-case bin-pack consumers onto coal furnaces;
    no aggregation across sources.  Returns (factor_by[(name,idx)], served_total,
    unserved) where factor is the heat throttle for each requiresHeat instance."""
    # furnace supplies (floor-scaled), tracked with remaining capacity
    furnaces = []  # [remaining_thermal]
    for f in placed.get("coal_furnace", []):
        furnaces.append(830.0 * (1 + f))
    served = [0] * len(furnaces)

    # gather heat consumers
    real = []     # (name, idx, demand) with heat_demand_kw > 0
    boolean = []  # (name, idx) with heat_demand_kw None
    for name, floors in placed.items():
        d = BUILDINGS[name]
        if not floors or not d.get("requiresHeat"):
            continue
        hd = d.get("heat_demand_kw")
        for i, f in enumerate(floors):
            if hd is None:
                boolean.append((name, i))
            else:
                real.append((name, i, hd * (1 + f)))

    factor = {}
    # real-demand: first-fit-decreasing onto furnaces with capacity
    for name, i, demand in sorted(real, key=lambda x: -x[2]):
        placed_ok = False
        for fi in sorted(range(len(furnaces)), key=lambda k: -furnaces[k]):
            if furnaces[fi] >= demand - 1e-9:
                furnaces[fi] -= demand
                served[fi] += 1
                factor[(name, i)] = 1.0
                placed_ok = True
                break
        if not placed_ok:
            factor[(name, i)] = 0.0  # unserved → triggers a heat fix
    # boolean: need any furnace present; bill it as served (no thermal cost)
    for name, i in boolean:
        if furnaces:
            fi = max(range(len(furnaces)), key=lambda k: furnaces[k])
            served[fi] += 1
            factor[(name, i)] = 1.0
        else:
            factor[(name, i)] = 0.0

    unserved = sum(1 for v in factor.values() if v < MIN_HEAT_FACTOR)
    served_total = sum(served)
    return factor, served_total, unserved


def needs_heat_fix(placed):
    """Returns an action to provision heat, or None if all consumers served.
    A single consumer whose demand exceeds every furnace's supply → floor up
    the largest coal furnace.  Otherwise capacity shortfall → add a furnace."""
    factor, _, unserved = resolve_heat(placed)
    if unserved == 0:
        return None
    if not placed.get("coal_furnace"):
        return ("place", "coal_furnace")
    # biggest single demand vs biggest single furnace supply (single-source rule)
    biggest = 0.0
    for name, floors in placed.items():
        d = BUILDINGS[name]
        if not floors or not d.get("requiresHeat"):
            continue
        hd = d.get("heat_demand_kw")
        if hd is None:
            continue
        for f in floors:
            biggest = max(biggest, hd * (1 + f))
    best_furnace = max(830.0 * (1 + f) for f in placed["coal_furnace"])
    if biggest > best_furnace + 1e-9:
        # must raise a single furnace's supply → upgrade lowest-floor furnace
        return balanced_scale(placed, "coal_furnace")
    return ("place", "coal_furnace")


def needs_buffer(placed, crate_for):
    """Return a crate action for the first recipe INTERMEDIATE whose storage cap
    can't hold a couple of a consumer's per-cycle draws, else None.  Without
    this, a small components cap (steel = 20) throttles a big consumer
    (beam_mill draws 105 steel/cycle) — it can never buffer a full cycle, so it
    crawls and backs its producer up at the cap.  Buffering intermediates lets
    the chain run continuously.  Only fires for resources the planner actually
    produces (skip raw extractor outputs already capped by design / starter)."""
    for name, floors in placed.items():
        if not floors:
            continue
        d = BUILDINGS[name]
        if d["cycle_s"] is None:
            continue
        f = max(floors)
        for r, per in d["in"].items():
            if per <= 0:
                continue
            need_cap = 2.0 * per * (1 + f)
            if nominal_cap(r, crate_for) + 1e-9 < need_cap:
                return crate_action_for(crate_for, r)
    return None


def needs_softgate_fix(placed):
    """If a placed building is soft-gated (§8.7) and its required gate-provider
    (exhaust_scrubber / wastewater_treatment) isn't present, return an action to
    place that provider — lifting the ×0.5 throttle.  Else None."""
    for name, floors in placed.items():
        if not floors:
            continue
        sg = BUILDINGS[name].get("soft_gate")
        if sg and not placed.get(sg):
            return ("place", sg)
    return None


def power_state(placed):
    """Returns (supply, demand) at NOMINAL throughput (pf=1).  Generators get
    the §4.5 cluster bonus; consumers' draw scales by floorPowerDrawMul(1+0.5L).
    demand here is the pf=1 upper bound used for the brownout fixpoint seed."""
    Kc = cluster_K(placed)
    supply = 0.0
    wf = placed.get("windmill", [])
    if wf:
        kw = Kc.get("power", 0.0)
        supply = sum(15 * (1 + f) * (1 + CLUSTER_RATE * (kw - (1 + f))) for f in wf)
    demand = 0.0
    for name, floors in placed.items():
        if not floors:
            continue
        p = BUILDINGS[name]["power"]
        if p >= 0:
            continue
        for f in floors:
            demand += (-p) * (1 + 0.5 * f)
    return supply, demand


def _flow_specs(placed, pf, heat_factor, Kc):
    """Build per-instance flow coefficients at brownout factor pf (power
    consumers' whole recipe pre-scaled by pf).  Returns (specs, index_meta)."""
    specs = []
    meta = []  # (name, idx, baseRate, consumes_power)
    for name, floors in placed.items():
        d = BUILDINGS[name]
        cyc = d["cycle_s"]
        if cyc is None:
            continue
        consumes_power = d["power"] < 0
        cat = d["category"]
        kcat = Kc.get(cat) if _CLUSTERED.get(name) else None
        scale_pf = pf if consumes_power else 1.0
        # §4.5/§8.7 soft gate: a gated building runs at ×0.5 unless its required
        # building is present (no-geometry = best-case adjacency, so "present"
        # ⇒ satisfied). Hard gates (heat) are handled separately above.
        sg = d.get("soft_gate")
        sg_factor = 0.5 if (sg and not placed.get(sg)) else 1.0
        for i, f in enumerate(floors):
            hf = heat_factor.get((name, i), 1.0) if d.get("requiresHeat") else 1.0
            if d.get("requiresHeat") and hf < MIN_HEAT_FACTOR:
                continue  # full heat stall → contributes nothing
            mul = (1 + f) * (1 + CLUSTER_RATE * (kcat - (1 + f))) if kcat is not None else (1 + f)
            base_rate = mul * hf * sg_factor / cyc   # cycles/sec for this instance
            produces = {r: u * base_rate * scale_pf for r, u in d["out"].items() if u > 0}
            consumes = {r: u * base_rate * scale_pf for r, u in d["in"].items() if u > 0}
            # §4.6 force-run waste-byproduct producers so a dead-end byproduct
            # cap can't stall the useful output.
            specs.append({"produces": produces, "consumes": consumes,
                          "ignore_output_cap": name in FORCE_RUN})
            meta.append((name, i, base_rate, consumes_power))
    return specs, meta


def net_rates(placed, inv, crate_for, production_only=False, force_full_power=False):
    """Faithful computeRates port → per-resource net units/sec.  Joint pf⇄gate
    fixpoint + exact solveFlow on inventory-derived cap/zero constraints.
    production_only=True → gross production at gate 1 (§4.9 throttle)."""
    Kc = cluster_K(placed)
    heat_factor, heat_served, _ = resolve_heat(placed)

    # --- cap/zero constraint set from inventory (pf-independent) ---
    specs1, meta1 = _flow_specs(placed, 1.0, heat_factor, Kc)
    cap_c, zero_c = set(), set()
    for sp in specs1:
        for r in list(sp["produces"]) + list(sp["consumes"]):
            stock = inv.get(r, 0.0)
            if stock <= STOCK_BOUNDARY_EPS:
                zero_c.add(r)
            if stock >= nominal_cap(r, crate_for) - STOCK_BOUNDARY_EPS:
                cap_c.add(r)
    # §5.2 synthetic coal-burn sink (cap-side) unless coal is zero-pinned
    coal_sink = None
    if "coal" not in zero_c and heat_served > 0:
        coal_sink = {"produces": {}, "consumes": {"coal": heat_served * 1 / COAL_CYCLE_SEC}}

    def specs_with_sink(specs):
        return specs + [coal_sink] if coal_sink else specs

    def solve_gates_at(pf):
        specs, meta = _flow_specs(placed, pf, heat_factor, Kc)
        gates = solve_flow(specs_with_sink(specs), cap_c, zero_c)
        return specs, meta, gates[:len(specs)]

    def aggregate_power(meta, gates):
        supply, demand = 0.0, 0.0
        wf = placed.get("windmill", [])
        if wf:
            kw = Kc.get("power", 0.0)
            supply = sum(15 * (1 + f) * (1 + CLUSTER_RATE * (kw - (1 + f))) for f in wf)
        # consumer draw scales by nominal throughput frac (cluster/heat gate × g)
        for (name, i, base_rate, consumes_power), g in zip(meta, gates):
            if not consumes_power:
                continue
            d = BUILDINGS[name]
            f = placed[name][i]
            # nominalThroughputFrac ≈ g (cluster/heat already baked into base_rate)
            demand += (-d["power"]) * (1 + 0.5 * f) * g
        return supply, demand

    # --- joint pf⇄g fixpoint (flow-power-fixpoint.ts) ---
    if production_only:
        pf = 1.0
        specs, meta, _ = solve_gates_at(1.0)
        gates = [1.0] * len(specs)
    else:
        def pf_of(pf):
            _, meta, gates = solve_gates_at(pf)
            s, dmd = aggregate_power(meta, gates)
            if force_full_power or dmd <= 1e-12:
                return 1.0
            return min(1.0, s / dmd)
        pf_full = pf_of(1.0)
        if force_full_power or pf_full >= 1 - 1e-6:
            pf = 1.0
        else:
            pf = pf_full
            for _ in range(64):
                target = pf_of(pf)
                nxt = (pf + target) / 2
                if abs(nxt - pf) < 1e-6:
                    pf = nxt
                    break
                pf = nxt
        specs, meta, gates = solve_gates_at(pf)

    # --- pass 4: realized net (gate-1 specs × g × (pf if power consumer)) ---
    specs1b, meta1b = _flow_specs(placed, 1.0, heat_factor, Kc)
    net = {}
    for (name, i, base_rate, consumes_power), g, sp in zip(meta1b, gates, specs1b):
        eff_pf = pf if (consumes_power and not production_only) else 1.0
        gg = 1.0 if production_only else g
        for r, v in sp["produces"].items():
            net[r] = net.get(r, 0.0) + v * gg * eff_pf
        if not production_only:
            for r, v in sp["consumes"].items():
                net[r] = net.get(r, 0.0) - v * gg * eff_pf
    # §5.2 coal burn fold — but only while coal isn't already empty.  Fix 4.1:
    # when coal stock is 0 the furnaces are fuel-starved (serve nothing, bill no
    # coal); folding the burn anyway drives net.coal negative at an empty bin.
    if heat_served and not production_only and "coal" not in zero_c:
        net["coal"] = net.get("coal", 0.0) - heat_served * 1 / COAL_CYCLE_SEC
    return net, pf


# ====================================================================
# AFFORDABILITY / TIME (v2 skeleton, adapted)
# ====================================================================
def time_to_afford(inv, cost, net, crate_for=None, gross=None):
    t = 0.0
    for r, need in cost.items():
        have = inv.get(r, 0)
        if have >= need:
            continue
        if crate_for is not None and need > max(nominal_cap(r, crate_for), have) + 1e-9:
            return float("inf")
        rate = net.get(r, 0.0)
        if rate <= 1e-12 and gross is not None:
            rate = gross.get(r, 0.0)
        if rate <= 1e-12:
            return float("inf")
        t = max(t, (need - have) / rate)
    return t


def crate_needed(cost, inv, crate_for):
    for r, need in cost.items():
        if need > max(nominal_cap(r, crate_for), inv.get(r, 0)) + 1e-9:
            return r
    return None


def upgrade_cost(name, target_displayed):
    base = BUILDINGS[name]["cost"]
    factor = 0.8 if target_displayed <= 10 else 0.8 * (1.15 ** (target_displayed - 10))
    return {r: ceil(n * factor) for r, n in base.items() if n > 0}


def cost_of(a):
    kind, name, *rest = a
    if kind == "place":
        return BUILDINGS[name]["cost"]
    if kind == "crate":
        return BUILDINGS["crate"]["cost"]
    if kind == "crate_up":
        return upgrade_cost("crate", rest[0])
    return upgrade_cost(name, rest[0])


def combined_cost(actions):
    total = {}
    for a in actions:
        for r, n in cost_of(a).items():
            total[r] = total.get(r, 0) + n
    return total


def fmt_dur(s):
    if s == float("inf"):
        return "never"
    h = s / 3600
    return f"{h:.2f} h" if h < 48 else f"{h / 24:.2f} days"


def floor_breakdown(floors):
    hist = {}
    for f in floors:
        hist[f + 1] = hist.get(f + 1, 0) + 1
    return ", ".join(f"fl{k}:{v}" for k, v in sorted(hist.items()))


# ====================================================================
# THE ONE SHARED MUTATION PRIMITIVE
# ====================================================================
def mutate(placed, crate_for, a):
    kind, name = a[0], a[1]
    if kind == "crate":
        crate_for.setdefault(name, []).append(0)
    elif kind == "crate_up":
        cf = crate_for[name]
        cf[min(range(len(cf)), key=lambda i: cf[i])] += 1
    elif kind == "place":
        placed[name].append(0)
    else:  # upgrade lowest-floor instance
        idx = min(range(len(placed[name])), key=lambda i: placed[name][i])
        placed[name][idx] += 1


class State:
    def __init__(self):
        self.placed = {name: [] for name in BUILDINGS}
        self.crate_for = {}
        self.inv = dict(STARTING_INVENTORY)
        self.t = 0.0

    def copy_placed(self):
        return {k: list(v) for k, v in self.placed.items()}


# ====================================================================
# SCALING (v2 skeleton)
# ====================================================================
FLOOR_SOFT_CAP = 9
TILE_FLOOR_CAP = 40


def balanced_scale(sim, typ):
    if sim[typ]:
        lo = min(sim[typ])
        # windmills upgrade to displayed level 11 before placing new ones: taller
        # windmills give more power per placement (and more cluster K) at lower
        # total cost than many short ones — measured ~14% faster overall build.
        soft = 10 if typ == "windmill" else FLOOR_SOFT_CAP
        if lo < soft:
            return ("upgrade", typ, lo + 2)
    if len(sim[typ]) < TERRAIN_CAPS[typ]:
        return ("place", typ)
    idx = min(range(len(sim[typ])), key=lambda i: sim[typ][i])
    if TERRAIN_CAPS[typ] < GRASS_CAP and sim[typ][idx] + 1 > TILE_FLOOR_CAP:
        return None
    return ("upgrade", typ, sim[typ][idx] + 2)


def has_producer(placed, r):
    return any(placed[p] for p in PRODUCERS_OF.get(r, ()))


def inputs_satisfied(name, placed):
    for r in BUILDINGS[name]["in"]:
        if not any(placed[p] for p in PRODUCERS_OF.get(r, ())):
            return False
    return True


def best_producer(sim, inv, crate_for, r):
    prods = [n for n in BUILDINGS
             if BUILDINGS[n]["out"].get(r, 0) > 0 and inputs_satisfied(n, sim)]
    if not prods:
        return None
    if len(prods) == 1:
        return prods[0]
    net = net_rates(sim, inv, crate_for)[0]

    def score(typ):
        d = BUILDINGS[typ]
        cyc = d["cycle_s"] or 1
        neg = tl = 0.0
        for x, u in d["in"].items():
            draw = u / cyc
            if x in TILE_LOCKED_RES:
                tl += draw
            after = net.get(x, 0.0) - draw
            if x != r and after < EPS:
                neg += (EPS - after) * (1000.0 if x in TILE_LOCKED_RES else 1.0)
        return (neg, tl, len(d["in"]))

    return min(prods, key=score)


def scale_cost_scalar(a):
    """Scalar cost proxy for an action — tile-locked resources weighted heavily
    (scarce, cap-1 producers), so the chooser avoids cascading onto them."""
    return sum(n * (1000.0 if r in TILE_LOCKED_RES else 1.0)
               for r, n in cost_of(a).items())


def scale_choice(sim, cf, typ, r):
    """Explicit UPGRADE-vs-BUILD tradeoff for raising `typ`'s output of `r`.
    Compares the two candidate actions — upgrade the lowest-floor instance, or
    place a new one — by marginal steady-state output / (weighted) cost, and
    returns the better.  This captures the real economics that the fixed floor-9
    heuristic only approximated: an upgrade ≤floor10 costs 0.8× base (cheap) but
    a new build costs full base AND adds a §4.5 cluster bonus to its same-category
    neighbours (reflected in its larger `gain`); past floor 10 the upgrade cost
    is exponential so building wins.  Preferring the higher output-per-cost
    naturally keeps it from degenerating to N×floor-1 buildings.  Returns None if
    neither candidate helps (typ is input-limited / capped)."""
    cur = net_rates(sim, {}, cf)[0].get(r, 0.0)
    cands = []
    if sim[typ]:
        lo = min(sim[typ])
        if not (TERRAIN_CAPS[typ] < GRASS_CAP and lo + 1 > TILE_FLOOR_CAP):
            cands.append(("upgrade", typ, lo + 2))
    if len(sim[typ]) < TERRAIN_CAPS[typ]:
        cands.append(("place", typ))
    best, best_val = None, 0.0
    for a in cands:
        s2 = {k: list(v) for k, v in sim.items()}
        mutate(s2, {}, a)
        gain = net_rates(s2, {}, cf)[0].get(r, 0.0) - cur
        if gain <= 1e-12:
            continue
        val = gain / max(scale_cost_scalar(a), 1.0)
        if val > best_val:
            best_val, best = val, a
    return best


SCALE_JUMP_CAP = 3000


def scale_action(sim, inv, crate_for, r):
    typ = best_producer(sim, inv, crate_for, r)
    if typ is None:
        return None
    cur = net_rates(sim, inv, crate_for)[0].get(r, 0.0)
    s = {k: list(v) for k, v in sim.items()}
    a1 = balanced_scale(s, typ)
    if a1 is None:
        return None
    mutate(s, {}, a1)
    dR = net_rates(s, inv, crate_for)[0].get(r, 0.0) - cur
    # If one scale of the best producer doesn't raise r's rate, r is limited by
    # something OTHER than this producer's count (an upstream tile-locked input
    # that's pinned) — scaling is futile and would loop. Give up; the caller
    # treats r as unfixable (it pins at 0 and throttles its consumers).
    if dR <= 1e-12:
        return None
    n_clear = ceil((EPS - cur) / dR)
    n = max(1, min(int(n_clear), SCALE_JUMP_CAP))
    acts = [a1]
    for _ in range(n - 1):
        a = balanced_scale(s, typ)
        if a is None:
            break
        acts.append(a)
        mutate(s, {}, a)
    return acts


def boost(sim, cf, r, depth=0, seen=None):
    """Return a scale action for the steady-state ROOT bottleneck limiting
    resource `r`, or None.  Tries to scale r's best producer; if that yields no
    steady-state gain (the producer is itself input-limited), recurses into the
    limiting input's producer — so boosting steel_beam walks down
    beam_mill → steel → steel_mill_scrap → scrap → scrapper and scales the real
    constraint.  All evaluation is at steady state (empty inventory) so transient
    stockpiles don't mask the true bottleneck."""
    if seen is None:
        seen = set()
    if depth > 12 or r in seen:
        return None
    seen.add(r)
    typ = best_producer(sim, {}, cf, r)
    if typ is None:
        return None
    # explicit upgrade-vs-build choice for raising r via typ
    a = scale_choice(sim, cf, typ, r)
    if a is not None:
        return a
    # typ can't help r (input-limited / capped) — recurse into its inputs.
    for x in BUILDINGS[typ]["in"]:
        rec = boost(sim, cf, x, depth + 1, seen)
        if rec is not None:
            return rec
    return None


def payback_scale(sim, cf, inv, cost):
    net = net_rates(sim, inv, cf)[0]
    bott, bt = None, 0.0
    for r, n in cost.items():
        have = inv.get(r, 0.0)
        if have >= n:
            continue
        rate = net.get(r, 0.0)
        t = (n - have) / rate if rate > 1e-12 else float("inf")
        if t > bt:
            bt, bott = t, r
    if bott is None or bt <= 0:
        return None
    r, rate = bott, net.get(bott, 0.0)
    typ = best_producer(sim, inv, cf, r)
    if typ is None:
        return None
    a = balanced_scale(sim, typ)
    if a is None:
        return None
    s2 = {k: list(v) for k, v in sim.items()}
    mutate(s2, {k: list(v) for k, v in cf.items()}, a)
    dR = net_rates(s2, inv, cf)[0].get(r, 0.0) - rate
    if dR <= 1e-12:
        return None
    remaining = cost[r] - inv.get(r, 0.0)
    gross = net_rates(sim, inv, cf, production_only=True)[0]
    t_pay = time_to_afford(inv, cost_of(a), net, cf, gross)
    if t_pay == float("inf"):
        return None
    t_now = remaining / rate if rate > 1e-12 else float("inf")
    t_up = t_pay + remaining / (rate + dR)
    return a if t_up < t_now else None


def plan_for(state, want):
    """Place `want` + the prerequisite fixes that make it AFFORDABLE and its
    operating state sustainable, returning the ordered action list (or None).

    With the exact solver, resources PIN (net 0 at cap, or balanced at zero)
    rather than going negative — so the v2 "every rate > EPS" invariant is wrong
    (it loops forever trying to 'fix' a full bin).  The v3 invariants are:
      1. TOPOLOGY  — every recipe input of `want` has a producer.
      2. HEAT      — every heat consumer is served (single-source thermal budget).
      3. POWER     — supply >= demand (no brownout) so producers aren't gated low.
      4. NO DRAIN  — no resource is genuinely draining (net < -EPS, not just pinned).
      5. AFFORD    — every cost resource of `want` can accumulate (net or §4.9
                     gross production > 0); if one has NO production, scale it.
    Then a payback-gated scale to speed the slowest cost resource."""
    sim = state.copy_placed()
    cf = {k: list(v) for k, v in state.crate_for.items()}
    inv = state.inv
    want_cost = cost_of(want)
    plan = [want]
    mutate(sim, cf, want)
    payback_used = 0
    for _ in range(PLAN_STEP_CAP):
        # 1. topology
        gated = [r for r in BUILDINGS[want[1]]["in"] if not has_producer(sim, r)]
        if gated:
            acts = scale_action(sim, inv, cf, gated[0])
            if acts is None:
                _FAIL[0] = f"no producer for input {gated[0]}"
                return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        # 2. heat
        hf = needs_heat_fix(sim)
        if hf is not None:
            plan.append(hf); mutate(sim, cf, hf); continue
        # 2.5 buffer recipe intermediates (so a big per-cycle draw fits in storage
        #     — steel cap 20 vs beam_mill's 105/cycle was throttling the chain)
        bf = needs_buffer(sim, cf)
        if bf is not None:
            plan.append(bf); mutate(sim, cf, bf); continue
        # 2.6 §8.7 soft gates — place exhaust_scrubber / wastewater_treatment so
        #     gated buildings run at full rate instead of ×0.5.
        sg = needs_softgate_fix(sim)
        if sg is not None:
            plan.append(sg); mutate(sim, cf, sg); continue
        # 3. power — add windmills only up to the MIN_PF brownout floor (full
        #    power would front-load iron_ingot on windmills and starve the
        #    smelter bootstrap; partial power just runs producers slower).
        sup, dem = power_state(sim)
        if dem > 1e-9 and sup < MIN_PF * dem - 1e-9:
            a = balanced_scale(sim, "windmill")
            if a is None:
                _FAIL[0] = "can't add power"
                return None
            plan.append(a); mutate(sim, cf, a); continue
        # 4. genuine drains, judged at STEADY STATE (empty inventory ⇒ every
        #    resource zero-pinned ⇒ consumers throttle to real production).  This
        #    is the key: judging drains against the live inventory is wrong —
        #    transient stockpiles (e.g. pig_iron banked while blast_furnace ran
        #    during the long advance) make an input-limited producer LOOK
        #    scalable, so the planner scaled steel_mill 8925× chasing a steel
        #    drain that only existed because it was burning a finite pig_iron
        #    stock.  At steady state no resource drains, so step 4 fixes only
        #    genuinely sustainable shortfalls; the rest pin and throttle.
        net = net_rates(sim, {}, cf)[0]
        drains = sorted(r for r, v in net.items() if v < -EPS)
        fixed = False
        for r in drains:
            acts = scale_action(sim, inv, cf, r)
            if acts:
                for a in acts:
                    plan.append(a); mutate(sim, cf, a)
                fixed = True
                break
        if fixed:
            continue
        # 5. affordability — a cost resource we lack with ZERO production anywhere
        gross = net_rates(sim, inv, cf, production_only=True)[0]
        unaccum = None
        for r, n in want_cost.items():
            if inv.get(r, 0.0) >= n:
                continue
            if net.get(r, 0.0) > 1e-12 or gross.get(r, 0.0) > 1e-12:
                continue
            unaccum = r
            break
        if unaccum is not None:
            acts = scale_action(sim, inv, cf, unaccum)
            if acts is None:
                _FAIL[0] = f"can't produce cost resource {unaccum}"
                return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        # 6. cost-aware bounded boost: speed up the slowest cost resource by
        #    scaling its steady-state ROOT bottleneck — but only while the plan's
        #    combined cost stays affordable (this is the guard the old payback
        #    lacked: it scaled against transient stock and built hundreds of
        #    buildings whose combined cost then blew past storage caps).
        # Don't run the time-optimizer boost until the iron_ingot faucet exists
        # in the COMMITTED state: during the pre-smelter bootstrap the starter
        # iron_ingot (60) is too tight for boost's quarry/extractor upgrades
        # (24 iron_ingot/floor) — keep that phase lean so the smelter gets placed.
        if has_producer(state.placed, "iron_ingot") and payback_used < PAYBACK_CAP:
            net_ss = net_rates(sim, {}, cf)[0]
            bott, bt = None, 0.0
            for rr, nn in want_cost.items():
                have = inv.get(rr, 0.0)
                if have >= nn:
                    continue
                rate = net_ss.get(rr, 0.0)
                t = (nn - have) / rate if rate > 1e-12 else float("inf")
                if t != float("inf") and t > bt:
                    bt, bott = t, rr
            if bott is not None and bt > 0:
                a = boost(sim, cf, bott)
                if a is not None:
                    trial = combined_cost(plan + [a])
                    gnet = net_rates(sim, inv, cf)[0]
                    ggross = net_rates(sim, inv, cf, production_only=True)[0]
                    if time_to_afford(inv, trial, gnet, cf, ggross) < float("inf"):
                        payback_used += 1
                        plan.append(a); mutate(sim, cf, a); continue
        return plan
    from collections import Counter
    hist = Counter(a[1] for a in plan)
    net_now = net_rates(sim, inv, cf)[0]
    drains_now = sorted((round(v * 3600, 2), r) for r, v in net_now.items() if v < -EPS)[:5]
    _FAIL[0] = (f"step cap {PLAN_STEP_CAP} hit (want={want[1]}); "
                f"top scaled: {hist.most_common(6)}; drains/h: {drains_now}")
    return None


# ====================================================================
# COMMIT
# ====================================================================
# §9.9 active bonus: recipe rate (intake+output) climbs +0.1%/min, 24/7, linearly
# (active-bonus.ts: activeBonusMul = 1 + (active-min)·0.001).  It scales every
# recipe rate UNIFORMLY, so it changes neither the flow gates nor the balance —
# only how fast inventory accrues.  So instead of integrating it per-step, we run
# the whole sim in BASE time τ (rates without the bonus, what state.t accumulates)
# and convert to REAL elapsed time only at display: with k = 0.001/60 per second,
#   τ(t) = ∫₀ᵗ(1+k·s)ds = t + k·t²/2   ⇒   t(τ) = (√(1 + 2kτ) − 1)/k.
ACTIVE_BONUS_K = 0.001 / 60.0   # per-second slope of the linear recipe-rate bonus


def real_time(tau):
    """Convert base (bonus-free) production time τ to real elapsed seconds under
    the 24/7 active-bonus acceleration."""
    return (((1 + 2 * ACTIVE_BONUS_K * tau) ** 0.5) - 1) / ACTIVE_BONUS_K


def advance(state, cost):
    """Advance BASE time until `cost` is affordable, integrating inventory at the
    current (bonus-free) rates, then deduct it.  state.t accumulates base time τ;
    the active-bonus speed-up is applied as a closed-form τ→real transform at
    display (see real_time / the §9.9 note above).  Single-segment with a [0,cap]
    clamp on both bounds.  Returns False if `cost` can never be afforded."""
    net = net_rates(state.placed, state.inv, state.crate_for)[0]
    gross = net_rates(state.placed, state.inv, state.crate_for, production_only=True)[0]
    dt = time_to_afford(state.inv, cost, net, state.crate_for, gross)
    if dt == float("inf"):
        return False
    for r in set(net) | set(cost):
        rate = net.get(r, 0.0)
        if rate <= 1e-12 and (cost.get(r, 0) - state.inv.get(r, 0.0)) > 0:
            rate = gross.get(r, 0.0)          # §4.9 gross fallback for stalled cost resources
        before = state.inv.get(r, 0.0)
        after = before + rate * dt
        capr = max(nominal_cap(r, state.crate_for), before)
        state.inv[r] = min(capr, max(0.0, after))   # clamp [0, cap]
    state.t += dt
    for r, n in cost.items():
        state.inv[r] = state.inv.get(r, 0.0) - n
    return True


def crate_action_for(crate_for, r):
    upgradable = [L for L in crate_for.get(r, []) if L < 10]
    if upgradable:
        return ("crate_up", r, min(upgradable) + 2)
    return ("crate", r)


def commit(state, plan):
    for _ in range(2000):
        cost = combined_cost(plan)
        cr = crate_needed(cost, state.inv, state.crate_for)
        if cr is None:
            break
        ca = crate_action_for(state.crate_for, cr)
        if not advance(state, cost_of(ca)):
            return False
        mutate(state.placed, state.crate_for, ca)
    else:
        return False
    if not advance(state, combined_cost(plan)):
        return False
    for a in plan:
        mutate(state.placed, state.crate_for, a)
    return True


# ====================================================================
# MAIN LOOP
# ====================================================================
def can_produce(placed, r):
    return any(BUILDINGS[p]["out"].get(r, 0) > 0 and (placed[p] or inputs_satisfied(p, placed))
               for p in BUILDINGS)


def ready(placed, name):
    return all(can_produce(placed, r) for r in BUILDINGS[name]["in"])


def assert_positive(state, label):
    """Sanity guard.  Under the exact solver a resource only goes net-negative
    while it still has STOCK to drain (it then pins at 0 and throttles its
    consumers next segment) — that is legal.  A negative at ~0 stock would mean
    the solver failed to pin a zero-bounded resource: THAT is the real bug."""
    net = net_rates(state.placed, state.inv, state.crate_for)[0]
    bad = {r: round(v * 3600, 4) for r, v in net.items()
           if v < -1e-6 and state.inv.get(r, 0.0) <= STOCK_BOUNDARY_EPS}
    if bad:
        raise AssertionError(f"NEGATIVE rate at empty bin after {label} "
                             f"@ {fmt_dur(real_time(state.t))}: {bad}")


def show_breakdown(state):
    print("    Final buildings (count, by displayed floor):")
    for n, fl in state.placed.items():
        if not fl:
            continue
        print(f"      {n:<24} x{len(fl):<4} {floor_breakdown(fl)}")
    if state.crate_for:
        tot = sum(len(v) for v in state.crate_for.values())
        print(f"      {'crate':<24} x{tot:<4} "
              + "; ".join(f"{r}:[{floor_breakdown(fl)}]"
                          for r, fl in sorted(state.crate_for.items())))
    net = net_rates(state.placed, state.inv, state.crate_for)[0]
    print("\n    Final inventory (net rate /h  /  stock  /  cap):")
    for r in sorted(state.inv):
        if abs(state.inv[r]) < 1e-6 and abs(net.get(r, 0)) < 1e-12:
            continue
        cap_r = max(nominal_cap(r, state.crate_for), state.inv[r])
        print(f"      {r:<16} {net.get(r, 0) * 3600:>+12.3f}/h  "
              f"{state.inv[r]:>12.2f} / {cap_r:.0f}")


def presize():
    """Auto-size the chain by raising TARGET counts so steady (cluster-aware) net
    production covers the whole build's GRASS-good placement demand within
    SIZE_WINDOW_S.  This is the lookahead the reactive boost lacks: nothing
    demands steel_beam until the apex, so the steel chain must be pre-built wide
    enough to fill 55000 steel_beam in the target window.  Tile-locked goods are
    excluded (cap-1 producers; they throttle at runtime).  Floors are left to the
    boost; this sizes COUNTS only.  Mutates TARGET in place."""
    place_rate = {}
    for b, cnt in TARGET.items():
        for r, n in BUILDINGS[b]["cost"].items():
            if r not in TILE_LOCKED_RES:
                place_rate[r] = place_rate.get(r, 0.0) + n * cnt / SIZE_WINDOW_S
    L = {b: float(TARGET.get(b, 0)) for b in BUILDINGS}

    def pick(r):
        prods = [p for p in PRODUCERS_OF.get(r, ()) if TERRAIN_CAPS[p] >= GRASS_CAP]
        if not prods:
            prods = list(PRODUCERS_OF.get(r, ()))
        if not prods:
            return None

        def sc(p):
            d = BUILDINGS[p]
            cyc = d["cycle_s"] or 1.0
            tl = sum(u / cyc for x, u in d["in"].items() if x in TILE_LOCKED_RES)
            return (tl, len(d["in"]))
        return min(prods, key=sc)

    for _ in range(200000):
        K = {}
        for b, c in L.items():
            if c > 0 and _CLUSTERED.get(b):
                K[_CATEGORY[b]] = K.get(_CATEGORY[b], 0.0) + c
        net = {}
        for b, c in L.items():
            cyc = BUILDINGS[b]["cycle_s"]
            if c <= 0 or cyc is None:
                continue
            bonus = 1 + CLUSTER_RATE * (K[_CATEGORY[b]] - 1) if _CLUSTERED.get(b) else 1.0
            for r, u in BUILDINGS[b]["out"].items():
                net[r] = net.get(r, 0.0) + c * u / cyc * bonus
            for r, u in BUILDINGS[b]["in"].items():
                net[r] = net.get(r, 0.0) - c * u / cyc * bonus
        worst, wr = -1e-9, None
        for r in set(net) | set(place_rate):
            if r not in PRODUCERS_OF or r in TILE_LOCKED_RES:
                continue
            v = net.get(r, 0.0) - place_rate.get(r, 0.0)
            if v < worst:
                worst, wr = v, r
        if wr is None or sum(L.values()) > 50000:
            break
        p = pick(wr)
        if p is None:
            break
        L[p] += 1.0

    # Realize the level-units as FLOORS, not N×floor-1 buildings: a building at
    # floor ~9 is worth ~10 floor-0 units (floorEffectMul = 1+L) at lower power
    # and the same cluster K, so target ⌈units/10⌉ buildings and let the boost's
    # scale_choice floor-upgrade them.  Avoids the degenerate N×floor-1 chain.
    for b, c in L.items():
        capped = min(int(ceil(c / 10.0)), TERRAIN_CAPS[b])
        if capped > TARGET.get(b, 0):
            TARGET[b] = capped


def main():
    global TARGET
    print("=" * 70)
    print("ROBOT ISLANDS — bootstrap build planner v3 (faithful economy)")
    print("=" * 70)

    state = State()
    if SEED_MODE:
        seed = json.load(open(SEED_PATH))
        state.inv = {r: float(v) for r, v in seed["inventory"].items()}
        for defid, floors in seed["placed"].items():
            if defid in BUILDINGS:
                state.placed[defid] = [int(f) for f in floors]
        only = os.environ.get("RI_ONLY", "coke_oven")
        TARGET = {only: len(state.placed.get(only, [])) + 1}
        print(f"SEED: build 1 more {only}.\n")

    # NOTE: presize() auto-sizing is disabled — it oversizes grass buildings
    # whose inputs are tile-locked (concrete_plant ×18 starves the single sand /
    # limestone deposit). The chain's construction materials are themselves
    # tile-locked-bound, so blind amortized sizing fights that wall. Left in the
    # source for future work behind a proper tile-locked supply cap.
    demand = sum(-BUILDINGS[n]["power"] for n in TARGET if BUILDINGS[n]["power"] < 0)
    print(f"Power demand of target consumers (base floor): {demand} kW\n")

    schedule = []
    deferred = set()
    step = 0
    while True:
        step += 1
        if step > 20000:
            print("!! step cap hit — aborting"); break
        need = {n: TARGET[n] - len(state.placed[n]) for n in TARGET
                if len(state.placed[n]) < TARGET[n]}
        if not need:
            break

        def tier(name):
            # The starter iron_ingot (60) is TIGHT: every building placed before
            # the smelter spends some, and newly-needed tile-locked extractors
            # (quartz_mine/sulfur_mine/… each 30) can drain it before the faucet
            # exists → bootstrap deadlock. So place the smelter (iron_ingot
            # producer; itself needs no iron_ingot) FIRST while iron_ingot has no
            # producer.
            if name == "smelter" and not has_producer(state.placed, "iron_ingot"):
                return -1
            if len(state.placed[name]) == 0:
                for r in BUILDINGS[name]["out"]:
                    if r in NEEDED_RES and not has_producer(state.placed, r):
                        return 0
            return 1
        oi = {n: i for i, n in enumerate(TARGET)}
        # (tier, TARGET-order): raw producers (logger/quarry/mines/clay) are
        # front-loaded so the stone/wood/ore faucets exist before their consumers
        # drain the starter cache.  Cost-first ordering was tried and BROKE this
        # (it placed stone-consumers before quarry, bankrupting starter stone).
        # The expensive apex producers are last in TARGET order, so they're only
        # attempted once everything cheaper is placed/deferred.
        cand = sorted((n for n in TARGET if n in need and ready(state.placed, n) and n not in deferred),
                      key=lambda n: (tier(n), oi[n]))
        progressed = False
        for name in cand:
            plan = plan_for(state, ("place", name))
            if plan is None or not commit(state, plan):
                deferred.add(name)
                continue
            assert_positive(state, f"place {name}")
            schedule.append((state.t, name, len(plan) - 1))
            placed_n = sum(1 for n in TARGET if len(state.placed[n]) >= TARGET[n])
            print(f"   [{placed_n:>2}/{len(TARGET)}] {fmt_dur(real_time(state.t)):>12}  place {name:<22} "
                  f"(+{len(plan) - 1} fixes)", flush=True)
            deferred.clear()
            progressed = True
            break

        if not progressed:
            print(f"\n!! BLOCKED @ {fmt_dur(real_time(state.t))} — every ready target deferred. "
                  f"still needed: {need}\n")
            for name in [n for n in TARGET if n in need and ready(state.placed, n)]:
                p = plan_for(state, ("place", name))
                if p is None:
                    print(f"    {name}: unbalanceable ({_FAIL[0]})")
                    continue
                tot = combined_cost(p)
                gross = net_rates(state.placed, state.inv, state.crate_for, production_only=True)[0]
                nt = net_rates(state.placed, state.inv, state.crate_for)[0]
                bad = [(r, n, round(nt.get(r, 0) * 3600, 1), round(nominal_cap(r, state.crate_for)))
                       for r, n in tot.items()
                       if time_to_afford(state.inv, {r: n}, nt, state.crate_for, gross) == float("inf")]
                print(f"    {name}: unaffordable; {len(p)}-action plan; blockers "
                      f"(need/rate-per-h/cap): {bad[:6]}")
            waiting = [n for n in need if not ready(state.placed, n)]
            if waiting:
                print(f"    waiting on inputs: {waiting}")
            print()
            show_breakdown(state)
            return

    print("Schedule (cumulative time -> target placed):")
    for ts, name, nfix in schedule:
        print(f"   {fmt_dur(real_time(ts)):>12}  place {name:<22} (+{nfix} balancing actions)")
    print(f"\n>>> Full target build placed in: {fmt_dur(real_time(state.t))}  "
          f"({sum(len(v) for v in state.placed.values())} buildings, "
          f"{sum(len(v) for v in state.crate_for.values())} crates)\n")
    show_breakdown(state)


if __name__ == "__main__":
    main()
