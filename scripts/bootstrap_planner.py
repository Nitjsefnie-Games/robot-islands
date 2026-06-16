#!/usr/bin/env python3
"""Robot Islands — bootstrap build PLANNER.

You provide DEFINITIONS (building catalog + terrain caps) and a TARGET
(count + floor per building). The engine forward-simulates a build schedule
and reports how fast the target build is reachable from the starter kit.

Modelled (per the mechanics we pinned down against the repo @ 44dfcb4):
  - placement cost only for affordability (footprint/tile gating -> capped via
    TERRAIN_CAPS, not simulated tile-by-tile)
  - terrain caps: how many of each building fit on the hand-placed home island
  - cluster bonus (§4.5): 1 + 0.05*(K - c_i), c_i = 1+floorLevel, K = sum c over
    the same-category 4-connected cluster. On home ONLY two things cluster:
      * loggers  (1x1, pack 4 into the 2x2 tree square) -> wood
      * windmills (1x1, any grass blob)                 -> power (produces only)
    every 2x2 extractor fills its feature cluster, walled by grass -> standalone (x1)
  - floor upgrades (§4.9): output x(1+L), power DRAW x(1+0.5L), cost per floor =
    ceil(0.8 * placementCost) for floors 2..10 (x1.15^(L-10) beyond)
  - power: shared brownout pf = min(1, supply/demand); generator output gets the
    cluster bonus, draw does NOT
  - input gating: smelter only operational once both mines exist (ore+coal flow)

SIMPLIFICATIONS (stated): infinite inventory cap; instant construction (no build
timer / running-slot queue); consumers assumed at full throughput for the power
demand estimate. Planner is a GREEDY heuristic (power-bias + skip-blocked), not a
proven-optimal search.
"""

from math import ceil
import os
import json

# Seed mode: RI_SEED=<json> loads a live island state (inventory + placed building
# floors); RI_ONLY=<defId> sets the target to "build one more of this". In seed mode
# storage caps are treated as effectively unlimited (the live island has a silo +
# crates), so the planner reports the PRODUCTION/upgrade path, not storage.
SEED_PATH = os.environ.get("RI_SEED")
SEED_MODE = bool(SEED_PATH)

CLUSTER_RATE = 0.05
# Terrain caps at/below this are "tile-locked" (loggers 4, mines/quarries 1-2):
# the bottleneck-attack fills them to cap. Above it (grass, 999) it upgrades.
TILE_LOCKED_MAX = 8

STARTING_INVENTORY = {
    "stone": 1200, "wood": 600, "iron_ore": 30, "coal": 80, "iron_ingot": 60,
    "bolt": 25, "limestone": 15, "saltwater_cell": 4, "foundation_kit": 1,
    "scrap": 5000,
}

# --- DEFINITIONS: building catalog (level-1 baseline) ---
#   cost      placement basket
#   power     +produces / -consumes kW at floor 0, full throughput
#   cycle_s   recipe cycleSec (None = no recipe / flat power)
#   in/out    units per cycle
#   category  drives cluster grouping
#   clusters  True only for the two that actually form clusters on home
BUILDINGS = {
    "logger":     {"cost": {"stone": 30, "wood": 30, "iron_ingot": 10}, "power": 0,
                   "cycle_s": 1404.1, "in": {}, "out": {"wood": 1},
                   "category": "extraction", "clusters": True},
    "quarry":     {"cost": {"stone": 120, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"stone": 1},
                   "category": "extraction", "clusters": False},
    "quartz_mine": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"quartz": 1},
                   "category": "extraction", "clusters": False},
    "iron_mine":  {"cost": {"stone": 200, "wood": 80}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"iron_ore": 1},
                   "category": "extraction", "clusters": False},
    "coal_mine":  {"cost": {"stone": 200, "wood": 80}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"coal": 1},
                   "category": "extraction", "clusters": False},
    "clay_pit":   {"cost": {"stone": 140, "wood": 80}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"clay": 1},
                   "category": "extraction", "clusters": False},
    "windmill":   {"cost": {"wood": 80, "stone": 20, "iron_ingot": 3}, "power": 15,
                   "cycle_s": None, "in": {}, "out": {},
                   "category": "power", "clusters": True},
    "smelter":    {"cost": {"stone": 400, "clay": 100, "wood": 20}, "power": -50,
                   "cycle_s": 2981.3, "in": {"iron_ore": 10, "coal": 3},
                   "out": {"iron_ingot": 6, "slag": 2, "co": 5},
                   "category": "smelting", "clusters": False},
    "workshop":   {"cost": {"wood": 150, "stone": 100, "iron_ingot": 30}, "power": -60,
                   "cycle_s": 4300, "in": {"iron_ore": 1, "coal": 1}, "out": {"bolt": 1},
                   "category": "manufacturing", "clusters": False},
    "limestone_quarry": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 40, "in": {}, "out": {"limestone": 1},
                   "category": "extraction", "clusters": False},
    "copper_mine": {"cost": {"stone": 150, "wood": 80, "iron_ingot": 30}, "power": -25,
                   "cycle_s": 20, "in": {}, "out": {"copper_ore": 1},
                   "category": "extraction", "clusters": False},
    "copper_smelter": {"cost": {"stone": 200, "iron_ingot": 80, "wood": 30, "clay": 40},
                   "power": -50, "cycle_s": 2774.2, "in": {"copper_ore": 1, "coal": 1},
                   "out": {"copper_ingot": 1}, "category": "smelting", "clusters": False},
    "sand_pit":   {"cost": {"stone": 120, "wood": 80, "iron_ingot": 20}, "power": -20,
                   "cycle_s": 40, "in": {}, "out": {"sand": 1},
                   "category": "extraction", "clusters": False},
    "glassworks": {"cost": {"stone": 200, "wood": 40, "iron_ingot": 30, "clay": 20}, "power": -80,
                   "cycle_s": 22337.5, "in": {"sand": 1}, "out": {"glass": 1},
                   "category": "manufacturing", "clusters": False},
    "well":       {"cost": {"stone": 20, "wood": 20, "iron_ingot": 5}, "power": -10,
                   "cycle_s": 16.4, "in": {}, "out": {"fresh_water": 1},
                   "category": "extraction", "clusters": False},
    "coastal_pump": {"cost": {"stone": 30, "wood": 20, "iron_ingot": 10}, "power": -15,
                   "cycle_s": 16.4, "in": {}, "out": {"saltwater": 1},
                   "category": "extraction", "clusters": False},
    # §5.2 heat source: 1x1, no electric draw, burns coal_per_cycle x served / HEAT_CYCLE_S.
    "coal_furnace": {"cost": {"stone": 50, "iron_ingot": 20, "wood": 30}, "power": 0,
                   "cycle_s": None, "in": {}, "out": {}, "category": "special",
                   "clusters": False, "coal_per_cycle": 1},
    # §4.6 generic storage: 1x1, labeled to one resource, +CRATE_MULT×base to it.
    "crate":      {"cost": {"wood": 80, "stone": 30}, "power": 0, "cycle_s": None,
                   "in": {}, "out": {}, "category": "storage", "clusters": False},
    "assembler":  {"cost": {"concrete": 7000, "stone": 4000, "iron_ingot": 2000,
                            "glass": 500, "copper_ingot": 300}, "power": -80,
                   "cycle_s": 573.3, "in": {"iron_ingot": 1, "bolt": 2}, "out": {"gear": 1},
                   "category": "manufacturing", "clusters": False},
    "steel_mill_scrap": {"cost": {"concrete": 20000, "stone": 15000, "iron_ingot": 8000,
                            "gear": 500, "clay": 5000, "copper_ingot": 500}, "power": -120,
                   "cycle_s": 72.8, "in": {"scrap": 2}, "out": {"steel": 1, "slag": 1},
                   "category": "smelting", "clusters": False},
    "brick_kiln": {"cost": {"stone": 200, "wood": 40, "iron_ingot": 20, "clay": 60},
                   "power": -50, "cycle_s": 64499.5, "in": {"clay": 6},
                   "out": {"brick": 5, "water_vapor": 1}, "category": "chemistry",
                   "clusters": False, "requiresHeat": True},
    "beam_mill":  {"cost": {"concrete": 10000, "stone": 6000, "iron_ingot": 3000,
                            "gear": 200, "clay": 2000, "copper_ingot": 200}, "power": -100,
                   "cycle_s": 36119.7, "in": {"steel": 105},
                   "out": {"steel_beam": 2, "mill_scale": 5},
                   "category": "manufacturing", "clusters": False},
    "pipe_mill":  {"cost": {"concrete": 10000, "stone": 7000, "iron_ingot": 3500,
                            "gear": 250, "clay": 2500, "copper_ingot": 300}, "power": -100,
                   "cycle_s": 14447.9, "in": {"steel": 42},
                   "out": {"pipe": 10, "mill_scale": 2},
                   "category": "manufacturing", "clusters": False},
    # §7.1/§8.7 heat-driven coke oven: HARD heat gate (requiresHeat) AND a SOFT
    # scrubber gate — whole recipe ×0.5 unless an Exhaust Scrubber serves it.
    "coke_oven":  {"cost": {"clay": 15000, "stone": 500, "pipe": 100}, "power": -60,
                   "cycle_s": 214998.3, "in": {"coal": 10},
                   "out": {"coke": 7, "wood_tar": 0.4, "hydrogen": 0.5, "co2": 1,
                           "refinery_gas": 1.1}, "category": "smelting",
                   "clusters": False, "requiresHeat": True, "scrub_mul": 0.5},
    # §8.7 emissions control: lifts the coke oven's 0.5 degrade. No recipe; draws power.
    "exhaust_scrubber": {"cost": {"steel_beam": 80, "concrete": 1500, "gear": 30,
                            "pipe": 50, "clay": 500}, "power": -20, "cycle_s": None,
                   "in": {}, "out": {}, "category": "special", "clusters": False},
    # §7.1 blast furnace: heat-driven pig-iron route; consumes COKE (-> coke oven
    # finally matters). HARD heat gate. Placement is steel_beam-heavy (30000).
    "blast_furnace": {"cost": {"steel_beam": 30000, "clay": 25000, "stone": 2000},
                   "power": -100, "cycle_s": 6217.4,
                   "in": {"iron_ore": 35, "coke": 18, "limestone": 10},
                   "out": {"pig_iron": 20, "slag": 6, "co2": 35},
                   "category": "smelting", "clusters": False, "requiresHeat": True},
    # air separator: makes oxygen (+nitrogen/argon) from ambient `air` (treated as
    # free, dropped from inputs). The oxygen producer the steel mill needs.
    "air_separator": {"cost": {"concrete": 2000, "glass": 400, "copper_ingot": 300,
                            "brick": 800}, "power": -300, "cycle_s": 1960.1, "in": {},
                   "out": {"nitrogen": 75.5, "oxygen": 23.2, "argon": 1.3},
                   "category": "chemistry", "clusters": False},
    # regular steel mill (pig-iron route): blast_furnace pig_iron + limekiln
    # quicklime + air_separator oxygen -> steel. Another big steel_beam sink.
    "steel_mill": {"cost": {"steel_beam": 25000, "clay": 8000, "stone": 2000},
                   "power": -120, "cycle_s": 4222.6,
                   "in": {"pig_iron": 100, "quicklime": 7, "oxygen": 9},
                   "out": {"steel": 85, "slag": 23, "co": 7, "co2": 1},
                   "category": "smelting", "clusters": False},
    "limekiln":   {"cost": {"stone": 200, "wood": 40, "iron_ingot": 30, "clay": 50},
                   "power": -60, "cycle_s": 119443.5, "in": {"limestone": 25},
                   "out": {"quicklime": 14, "co2": 11}, "category": "chemistry",
                   "clusters": False, "requiresHeat": True},
    "cement_mill": {"cost": {"stone": 200, "iron_ingot": 60, "wood": 30}, "power": -80,
                   "cycle_s": 9957.8, "in": {"quicklime": 8, "clay": 2, "sand": 1},
                   "out": {"cement": 11}, "category": "chemistry",
                   "clusters": False, "requiresHeat": True},
    "concrete_plant": {"cost": {"stone": 150, "iron_ingot": 40, "wood": 40, "clay": 20},
                   "power": -60, "cycle_s": 5431.5,
                   "in": {"cement": 1, "sand": 2, "stone": 3, "fresh_water": 0.5},
                   "out": {"concrete": 6}, "category": "chemistry", "clusters": False},
}

# --- DEFINITIONS: terrain caps on the home island (hand-placed clusters) ---
TERRAIN_CAPS = {
    "logger": 4,      # 2x2 tree square, 1x1 loggers
    # quarry + quartz_mine SHARE the two stone 2x2 clusters (both need 'stone'):
    # one quarry on one cluster, one quartz mine on the other.
    "quarry": 1,
    "quartz_mine": 1,
    "iron_mine": 1,   # one ore cluster
    "coal_mine": 1,   # one coal 2x2
    "clay_pit": 1,    # one clay_pit 2x2
    "windmill": 999,  # 682 grass -> effectively unlimited
    "smelter": 999,   # placed on grass
    "workshop": 999,  # grass
    "limestone_quarry": 1,  # one limestone 2x2
    "copper_mine": 1,       # one copper_vein 2x2
    "copper_smelter": 999,  # grass
    "sand_pit": 1,          # one sand 2x2
    "glassworks": 999,      # grass
    # well + coastal_pump are 1x1 and SHARE the single 4-tile water cluster;
    # caps are generous but the combined placed count must stay <= 4 water tiles.
    "well": 4,
    "coastal_pump": 4,
    "coal_furnace": 999,    # 1x1 on grass, auto-placed
    "limekiln": 999,        # grass
    "cement_mill": 999,     # grass
    "concrete_plant": 999,  # grass
    "crate": 999,           # grass
    "assembler": 999,       # grass
    "steel_mill_scrap": 999,  # grass (3x3)
    "brick_kiln": 999,      # grass
    "beam_mill": 999,       # grass
    "pipe_mill": 999,       # grass
    "coke_oven": 999,       # grass
    "exhaust_scrubber": 999,  # grass, auto-placed
    "blast_furnace": 999,   # grass (3x3)
    "air_separator": 999,   # grass (3x3)
    "steel_mill": 999,      # grass (3x3)
}

# --- AUTO-GENERATED scrap faucets: one {name}_scrapper per base building ---
# Each models the §6.7 + §14 place+demolish recycling loop on that building's
# placement basket (grounded in placement.ts::demolishBuilding):
#   per loop you re-spend the NON-refunded half of the basket and mint scrap.
#     §14 refund = floor(n/2) per resource  -> net consumed = n - floor(n/2)
#     §6.7 scrap = floor(0.3 * Σ basket)
# cycle_s is tuned so a floor-1 scrapper's scrap/s equals one floor-1
# steel_mill_scrap's scrap intake (2 scrap / 72.8 s) — matching the original
# hand-built scrapper/air_scrapper. The planner scales scrap by picking the best
# feasible scrapper via best_scale (boost_for sees them as scrap producers
# automatically); none is forced into TARGET. `_base` is captured from the base
# catalog BEFORE generation, so scrappers don't recurse on themselves.
_SMS = BUILDINGS["steel_mill_scrap"]
_SCRAP_REF_PER_S = _SMS["in"]["scrap"] / _SMS["cycle_s"]  # 2 / 72.8 scrap-per-s
for _base in list(BUILDINGS):
    _cost = BUILDINGS[_base]["cost"]
    _scrap_out = sum(_cost.values()) * 3 // 10          # floor(0.3 * Σ basket)
    if _scrap_out <= 0:
        continue
    _consumed = {r: n - n // 2 for r, n in _cost.items() if n - n // 2 > 0}
    BUILDINGS[f"{_base}_scrapper"] = {
        "cost": {"fresh_water": 50}, "power": 0,
        "cycle_s": _scrap_out / _SCRAP_REF_PER_S,
        "in": _consumed, "out": {"scrap": _scrap_out},
        "category": "special", "clusters": False,
    }
    TERRAIN_CAPS[f"{_base}_scrapper"] = 999

# --- TARGET: count + displayed floor per building (floor 1 = base, no upgrade) ---
# Windmills are auto-sized to power the consumers below; override by setting a count.
# Minimum FUNCTIONAL build (1 each). The planner is free to place EXTRA
# producers (up to TERRAIN_CAPS) and upgrade them to attack the binding
# bottleneck — windmills sized on-demand. Completion = this set is placed.
TARGET = {
    "logger":    {"count": 4, "floor": 1},
    "quarry":    {"count": 1, "floor": 1},
    "quartz_mine": {"count": 1, "floor": 1},
    "iron_mine": {"count": 1, "floor": 1},
    "coal_mine": {"count": 1, "floor": 1},
    "clay_pit":  {"count": 1, "floor": 1},
    "smelter":   {"count": 1, "floor": 1},
    "workshop":         {"count": 1, "floor": 1},
    "limestone_quarry": {"count": 1, "floor": 1},
    "copper_mine":      {"count": 1, "floor": 1},
    "copper_smelter":   {"count": 1, "floor": 1},
    "sand_pit":         {"count": 1, "floor": 1},
    "glassworks":       {"count": 1, "floor": 1},
    "well":             {"count": 1, "floor": 1},
    "coastal_pump":     {"count": 1, "floor": 1},
    "limekiln":         {"count": 1, "floor": 1},
    "cement_mill":      {"count": 1, "floor": 1},
    "concrete_plant":   {"count": 1, "floor": 1},
    "assembler":        {"count": 1, "floor": 1},
    "steel_mill_scrap": {"count": 1, "floor": 1},
    "brick_kiln":       {"count": 1, "floor": 1},
    "beam_mill":        {"count": 1, "floor": 1},
    "pipe_mill":        {"count": 1, "floor": 1},
    "coke_oven":        {"count": 1, "floor": 1},
    "blast_furnace":    {"count": 1, "floor": 1},
    "air_separator":    {"count": 1, "floor": 1},
    "steel_mill":       {"count": 1, "floor": 1},
    # "windmill" sized on-demand; "coal_furnace"/"exhaust_scrubber" auto-placed
}


def cluster_bonus(floors, i):
    """§4.5 bonus for member i of a cluster whose members have these floorLevels."""
    K = sum(1 + f for f in floors)
    c_i = 1 + floors[i]
    return 1 + CLUSTER_RATE * (K - c_i)


# §4.5 grass clusters group by CATEGORY: on plentiful grass the player co-locates
# all same-category production buildings into one 4-connected cluster, so they
# pool their floor-capacity. (smelter+copper_smelter=smelting; limekiln+
# cement_mill+concrete_plant=chemistry; workshop+glassworks=manufacturing.)
# Feature-tile extractors sit on scattered clusters -> standalone; the lone
# exception is loggers (clusters=True, packed 4 into the 2x2 tree square), and
# windmills (clusters=True, packed on grass). Both grouped by category below.
GRASS_CLUSTER_CATS = {"smelting", "chemistry", "manufacturing"}


def is_clustered(name):
    d = BUILDINGS[name]
    return bool(d.get("clusters")) or d["category"] in GRASS_CLUSTER_CATS


def cluster_K(placed):
    """category -> Σ(1+floorLevel) over all clustered instances of that category."""
    K = {}
    for name, fl in placed.items():
        if not is_clustered(name) or not fl:
            continue
        cat = BUILDINGS[name]["category"]
        K[cat] = K.get(cat, 0.0) + sum(1 + f for f in fl)
    return K


def upgrade_cost(name, target_displayed):
    """§4.9 per-floor cost to raise into displayed floor `target_displayed`."""
    base = BUILDINGS[name]["cost"]
    factor = 0.8 if target_displayed <= 10 else 0.8 * (1.15 ** (target_displayed - 10))
    return {r: ceil(n * factor) for r, n in base.items() if n > 0}


# --- §4.6 storage caps ---
# baselineCap(r) = per-resource override else the category default. Every resource
# in THIS build is dry_goods or a gas (both default 100); the overrides below are
# the §4.6 special cases (foundation_kit 5, ai_core 0, helium_3/antimatter 1).
RESOURCE_BASE_CAP = {"foundation_kit": 5, "ai_core": 0, "helium_3": 1,
                     "antimatter_propellant": 1}
DEFAULT_BASE_CAP = 100          # dry_goods / liquid_gas default
CRATE_MULT = 5                  # Crate storage.capacity (percentage multiplier)


def baseline_cap(r):
    return RESOURCE_BASE_CAP.get(r, DEFAULT_BASE_CAP)


def storage_base_for(r):
    return max(5, baseline_cap(r))


def nominal_cap(r, crate_for):
    """Production ceiling for r: base + Σ Crate contributions. Each crate at
    floorLevel L adds CRATE_MULT × base × (1+L) (§4.9 storage floor-scaling), so
    `crate_for[r]` is a LIST of crate floorLevels. The §12.4 starter grace lets
    seeded stock be HELD above this but never refilled, so production clamps here."""
    if SEED_MODE:
        return 1e15  # live island has ample storage (silo + crates); don't gate on caps
    base = storage_base_for(r)
    return baseline_cap(r) + sum(CRATE_MULT * base * (1 + L) for L in crate_for.get(r, []))


# §5.2 heat: a coal furnace (1x1) serves up to FURNACE_FANOUT adjacent heat
# consumers and burns coalPerCycle x served coal per HEAT_CYCLE_S seconds.
FURNACE_FANOUT = 4
HEAT_CYCLE_S = 30


def n_heat(placed):
    """Number of placed heat consumers (requiresHeat)."""
    return sum(len(placed[n]) for n in BUILDINGS if BUILDINGS[n].get("requiresHeat"))


def heat_capacity(placed):
    """How many heat consumers the placed coal furnaces can serve."""
    return FURNACE_FANOUT * len(placed.get("coal_furnace", []))


# §8.7 exhaust scrubber: a high-emission building (scrub_mul set, e.g. coke_oven)
# runs at full rate only if an adjacent Exhaust Scrubber serves it; otherwise its
# whole recipe is degraded by scrub_mul (0.5). Soft gate — still runs, half rate.
SCRUBBER_FANOUT = 4


def n_scrub(placed):
    """Number of placed scrubber-gated buildings (high-emission, e.g. coke_oven)."""
    return sum(len(placed[n]) for n in BUILDINGS if BUILDINGS[n].get("scrub_mul"))


def scrub_capacity(placed):
    """How many high-emission buildings the placed exhaust scrubbers serve."""
    return SCRUBBER_FANOUT * len(placed.get("exhaust_scrubber", []))


def power_state(placed):
    """Return (supply_kw, demand_kw). A heat consumer draws power only while it
    is heat-served (within furnace capacity) AND its inputs exist."""
    supply = 0.0
    wf = placed.get("windmill", [])
    for i, f in enumerate(wf):
        supply += 15 * (1 + f) * cluster_bonus(wf, i)
    demand = 0.0
    heat_cap, heat_used = heat_capacity(placed), 0
    for name, floors in placed.items():
        d = BUILDINGS[name]
        if d["power"] >= 0:
            continue
        if d["in"] and not inputs_satisfied(name, placed):
            continue
        for f in floors:
            if d.get("requiresHeat"):
                if heat_used >= heat_cap:
                    continue  # unserved -> idle, draws no power
                heat_used += 1
            demand += (-d["power"]) * (1 + 0.5 * f)
    return supply, demand


def inputs_satisfied(name, placed):
    """A consumer only operates once EVERY recipe-input resource has a placed
    producer (generalises the old smelter-needs-both-mines gate to all chains).
    Producers (no inputs) are always satisfied."""
    for r in BUILDINGS[name]["in"]:
        if not any(BUILDINGS[p]["out"].get(r, 0) > 0 and placed[p] for p in BUILDINGS):
            return False
    return True


def net_rates(placed, production_only=False):
    """Per-resource net units/sec under power brownout + cluster + floor + input gating.
    production_only=True returns GROSS production (outputs only, no input/fuel draw) —
    used to model the §4.9 free floor-downgrade throttle: a deadlocked resource can be
    accumulated at its gross rate by temporarily downgrading its consumers."""
    supply, demand = power_state(placed)
    pf = min(1.0, supply / demand) if demand > 1e-12 else 1.0
    net = {}
    Kc = cluster_K(placed)
    heat_cap, heat_served = heat_capacity(placed), 0
    scrub_cap, scrub_served = scrub_capacity(placed), 0
    for name, floors in placed.items():
        d = BUILDINGS[name]
        if d["cycle_s"] is None:
            continue  # windmill / coal_furnace / exhaust_scrubber: no recipe flow
        if d["in"] and not inputs_satisfied(name, placed):
            continue
        clustered = is_clustered(name)
        for f in floors:
            if d.get("requiresHeat"):
                if heat_served >= heat_cap:
                    continue  # no furnace serves it -> rate 0 (§5.2)
                heat_served += 1
            # §4.5: bonus from the building's CATEGORY cluster (not just its type)
            bonus = 1 + CLUSTER_RATE * (Kc[d["category"]] - (1 + f)) if clustered else 1.0
            mul = (1 + f) * bonus
            # §8.7 exhaust-scrubber soft gate: ×scrub_mul unless a scrubber serves it
            if d.get("scrub_mul"):
                if scrub_served < scrub_cap:
                    scrub_served += 1
                else:
                    mul *= d["scrub_mul"]
            if d["power"] < 0:
                mul *= pf
            for r, u in d["out"].items():
                net[r] = net.get(r, 0.0) + (u / d["cycle_s"]) * mul
            if not production_only:
                for r, u in d["in"].items():
                    net[r] = net.get(r, 0.0) - (u / d["cycle_s"]) * mul
    # §5.2 furnace fuel: coalPerCycle x served consumers per HEAT_CYCLE_S.
    if heat_served and not production_only:
        cpc = BUILDINGS["coal_furnace"]["coal_per_cycle"]
        net["coal"] = net.get("coal", 0.0) - heat_served * cpc / HEAT_CYCLE_S
    return net, pf


def time_to_afford(inv, cost, net, crate_for=None, gross=None):
    """Time until `cost` is affordable. With `crate_for`, accumulation is capped at
    each resource's nominal cap (over-cap -> inf, storage guard adds a crate). With
    `gross`, a resource that's net<=0 (deadlocked) accumulates at its GROSS rate —
    modelling the §4.9 free floor-downgrade throttle (its consumers briefly idled)."""
    t = 0.0
    for r, need in cost.items():
        have = inv.get(r, 0)
        if have >= need:
            continue
        if crate_for is not None and need > max(nominal_cap(r, crate_for), have) + 1e-9:
            return float("inf")  # cap binds -> needs a crate
        rate = net.get(r, 0.0)
        if rate <= 1e-12 and gross is not None:
            rate = gross.get(r, 0.0)   # throttle consumers (free, reversible) to free r
        if rate <= 1e-12:
            return float("inf")
        t = max(t, (need - have) / rate)
    return t


def crate_needed(cost, inv, crate_for):
    """First resource whose cost exceeds its reachable cap (nominal or held
    grace stock), so a crate must raise the cap before it can be accumulated."""
    for r, need in cost.items():
        if need > max(nominal_cap(r, crate_for), inv.get(r, 0)) + 1e-9:
            return r
    return None


def binding_resources(inv, cost, net):
    """Which resource(s) gated this action — i.e. hit the max(deficit/rate)
    wait. Empty when the action was already affordable from stock (dt=0)."""
    times = {}
    for r, need in cost.items():
        deficit = need - inv.get(r, 0)
        if deficit <= 0:
            continue
        rate = net.get(r, 0.0)
        times[r] = float("inf") if rate <= 1e-12 else deficit / rate
    if not times:
        return []
    mx = max(times.values())
    if mx <= 0:
        return []
    return [r for r, v in times.items() if v == mx]


def windmill_power(floors):
    """Total kW from a single clustered windmill blob with these floorLevels."""
    return sum(15 * (1 + f) * cluster_bonus(floors, i) for i, f in enumerate(floors))


def fmt_dur(s):
    if s == float("inf"):
        return "never"
    h = s / 3600
    return f"{h:.2f} h" if h < 48 else f"{h/24:.2f} days"


def floor_breakdown(floors):
    """Histogram of a building type's instances by DISPLAYED floor (floorLevel+1)."""
    hist = {}
    for f in floors:
        hist[f + 1] = hist.get(f + 1, 0) + 1
    return ", ".join(f"fl{k}:{v}" for k, v in sorted(hist.items()))


def build_action_list(already=None):
    """Flatten the non-windmill TARGET into place/upgrade actions. `already` maps
    defId -> count already placed (seed mode), subtracted from each target count."""
    already = already or {}
    actions = []  # (kind, name)
    for name, spec in TARGET.items():
        cnt = min(spec["count"], TERRAIN_CAPS[name]) - already.get(name, 0)
        cnt = max(0, cnt)
        actions.extend([("place", name)] * cnt)
        # floor upgrades: each of the cnt instances needs (floor-1) upgrade steps
        actions.extend([("upgrade", name)] * (cnt * max(0, spec["floor"] - 1)))
    return actions


def main():
    global TARGET
    print("=" * 70)
    print("ROBOT ISLANDS — bootstrap build planner (greedy)")
    print("=" * 70)

    inv = dict(STARTING_INVENTORY)
    placed = {name: [] for name in BUILDINGS}
    crate_for = {}   # resource -> number of Crates labeled to it (each +CRATE_MULT×base cap)

    if SEED_MODE:
        seed = json.load(open(SEED_PATH))
        inv = {r: float(v) for r, v in seed["inventory"].items()}
        skipped = []
        for defid, floors in seed["placed"].items():
            if defid in BUILDINGS:
                placed[defid] = [int(f) for f in floors]
            else:
                skipped.append(defid)
        only = os.environ.get("RI_ONLY", "coke_oven")
        have = len(placed.get(only, []))
        TARGET = {only: {"count": have + 1, "floor": 1}}
        print(f"\nSEED: live island lvl {seed.get('level')} — loaded "
              f"{sum(len(v) for v in placed.values())} known buildings; "
              f"skipped {len(skipped)} unmodeled ({', '.join(sorted(set(skipped)))}).")
        print(f"GOAL: build 1 more {only} (you have {have}). Caps treated as unlimited "
              f"(you have a silo + crates).\n")

    demand = sum(-BUILDINGS[n]["power"] for n in TARGET if BUILDINGS[n]["power"] < 0)
    print(f"Power demand of target consumers (base floor): {demand} kW\n")

    remaining = build_action_list({n: len(placed[n]) for n in placed})
    deferred = set()  # actions parked this round (consumer can't be supported yet); retried after progress
    t = 0.0
    schedule = []

    def cost_of(a):
        kind, name, *rest = a
        if kind == "place":
            return BUILDINGS[name]["cost"]
        if kind == "crate":          # new crate (floor 1)
            return BUILDINGS["crate"]["cost"]
        if kind == "crate_up":       # upgrade a crate; rest[0] = target displayed floor
            return upgrade_cost("crate", rest[0])
        # building upgrade: rest[0] is the target DISPLAYED floor
        return upgrade_cost(name, rest[0])

    _diag_seen = set()  # [TEMP DIAG]

    def advance_and_apply(a, net):
        """Advance time to afford `a` (a single action OR a LIST of actions applied
        as one ATOMIC batch) and apply it. A batch is afforded against the COMBINED
        cost at a single time-point and all building changes land together, so
        net_rates is only ever observed at the settled (post-batch) state — never at
        a mid-batch intermediate (matters for cluster-coupled scaling, whose
        intermediates can dust-dip even though the settled state is strictly
        positive)."""
        nonlocal t
        actions = a if isinstance(a, list) else [a]
        _pre = net_rates(placed)[0]  # [TEMP DIAG]
        cost = {}                    # COMBINED cost — the batch lands at one instant
        for act in actions:
            for r, n in cost_of(act).items():
                cost[r] = cost.get(r, 0) + n
        throttle = binding_resources(inv, cost, net)
        gross = net_rates(placed, production_only=True)[0]
        dt = time_to_afford(inv, cost, net, crate_for, gross)
        for r in set(net) | set(cost):
            rate = net.get(r, 0.0)
            # §4.9 throttle: a deadlocked resource needed here accumulates at its
            # gross rate (its consumers briefly downgraded — free & reversible).
            if rate <= 1e-12 and (cost.get(r, 0) - inv.get(r, 0)) > 0:
                rate = gross.get(r, 0.0)
            before = inv.get(r, 0)
            after = before + rate * dt
            if rate > 0:  # §4.6 force-on: production can't refill past the holding cap
                after = min(after, max(nominal_cap(r, crate_for), before))
            inv[r] = after
        t += dt
        for r, n in cost.items():
            inv[r] = inv.get(r, 0) - n
        for act in actions:
            kind, name = act[0], act[1]
            if kind == "crate":                   # new crate for resource `name`, floor 1
                crate_for.setdefault(name, []).append(0)
            elif kind == "crate_up":              # upgrade the lowest crate for `name`
                cf = crate_for[name]
                cf[min(range(len(cf)), key=lambda i: cf[i])] += 1
            elif kind == "place":
                placed[name].append(0)
            else:  # upgrade lowest-floor instance of this type
                idx = min(range(len(placed[name])), key=lambda i: placed[name][i])
                placed[name][idx] += 1
        _post = net_rates(placed)[0]  # [TEMP DIAG]
        for r, v in _post.items():
            if v < 1e-9 and r not in _diag_seen and _pre.get(r, 0.0) >= 1e-9:
                _diag_seen.add(r)
                print(f"[DIAG] {r} -> NEG ({v*3600:+.2f}/h) first driven by {a} "
                      f"@ t={fmt_dur(t)}")
        return ", ".join(throttle) if throttle else "—"

    def windmill_decision(net):
        """Return the better power action among {add new, upgrade lowest},
        by marginal kW per wood spent, restricted to affordable options. Uses the
        §4.9 gross-throttle for affordability so a wood pinned at net 0 (its loggers
        balanced by wood-consuming scrappers) can still be accumulated for the
        windmill by briefly idling those consumers."""
        wf = placed["windmill"]
        gross = net_rates(placed, production_only=True)[0]
        cands = []  # (kw_per_wood, action, label)
        # add a fresh windmill
        add_cost = BUILDINGS["windmill"]["cost"]
        if time_to_afford(inv, add_cost, net, gross=gross) < float("inf"):
            dP = windmill_power(wf + [0]) - windmill_power(wf)
            cands.append((dP / add_cost["wood"], ("place", "windmill"), "add"))
        # upgrade the lowest-floor existing windmill
        if wf:
            idx = min(range(len(wf)), key=lambda i: wf[i])
            target_disp = wf[idx] + 2  # floorLevel f -> f+1 == displayed f+2
            up_cost = upgrade_cost("windmill", target_disp)
            if time_to_afford(inv, up_cost, net, gross=gross) < float("inf"):
                bumped = list(wf); bumped[idx] += 1
                dP = windmill_power(bumped) - windmill_power(wf)
                cands.append((dP / up_cost["wood"], ("upgrade", "windmill", target_disp), "upgrade"))
        if not cands:
            return None, None
        cands.sort(reverse=True)
        return cands[0][1], cands[0][2]

    def has_producer(r):
        return any(BUILDINGS[n]["out"].get(r, 0) > 0 and placed[n] for n in BUILDINGS)

    def target_can_produce(r):
        """True if some TARGET building produces r — i.e. the normal flow will
        place a producer for r, so r needs no scrapper bootstrap."""
        return any(BUILDINGS[n]["out"].get(r, 0) > 0 and n in TARGET for n in BUILDINGS)

    def placed_with(action):
        """A copy of `placed` with `action` (place / upgrade-lowest) applied."""
        p2 = {k: list(v) for k, v in placed.items()}
        name = action[1]
        if action[0] == "place":
            p2[name].append(0)
        else:
            idx = min(range(len(p2[name])), key=lambda i: p2[name][i])
            p2[name][idx] += 1
        return p2

    def net_with(action):
        """Net rates if `action` were applied — for marginal Δrate."""
        return net_rates(placed_with(action))[0]

    def boost_for(R, net):
        """ALL ways to raise production of R — every producer's add (under cap)
        and upgrade-lowest. Returns a list of (action, label, dR, t_b) so the
        caller can pick across producers (e.g. smelter-scrapper vs air-scrapper)."""
        cands = []
        gross = net_rates(placed, production_only=True)[0]  # §4.9 throttle-aware affordability
        for typ in (n for n in BUILDINGS if BUILDINGS[n]["out"].get(R, 0) > 0):
            # headroom = cap minus already-placed minus still-pending REQUIRED places
            pending = sum(1 for a in remaining if a[0] == "place" and a[1] == typ)
            if len(placed[typ]) + pending < TERRAIN_CAPS[typ]:
                a = ("place", typ)
                tb = time_to_afford(inv, BUILDINGS[typ]["cost"], net, gross=gross)
                if tb < float("inf"):
                    dR = net_with(a).get(R, 0) - net.get(R, 0)
                    if dR > 1e-12:
                        cands.append((a, "add", dR, tb))
            if placed[typ]:
                idx = min(range(len(placed[typ])), key=lambda i: placed[typ][i])
                td = placed[typ][idx] + 2
                tb = time_to_afford(inv, upgrade_cost(typ, td), net, gross=gross)
                if tb < float("inf"):
                    a = ("upgrade", typ, td)
                    dR = net_with(a).get(R, 0) - net.get(R, 0)
                    if dR > 1e-12:
                        cands.append((a, "upg", dR, tb))
        return cands

    def pays_back(R, dR, tb, net):
        """Does this boost recover its wait over the remaining REQUIRED R-demand?"""
        rate_old = net.get(R, 0)
        if rate_old <= 1e-12:
            return True
        rem = sum(cost_of(a).get(R, 0) for a in remaining)
        if rem <= 0:
            return False
        return tb + rem / (rate_old + dR) < rem / rate_old

    def best_scale(R, net, gated):
        """Pick how to raise R across ALL producers: marginal Δrate-of-R per time
        invested (Δrate / time-to-afford), but DEPRIORITIZE a scale that drives
        some OTHER resource net-negative (a cascade) — so a surplus-fed source
        (air-scrapper: concrete/glass/copper/brick) beats one that starves a
        bottleneck (smelter-scrapper: stone). `gated` requires payback."""
        cands = []
        for a, lbl, dR, tb in boost_for(R, net):
            if gated and not pays_back(R, dR, tb, net):
                continue
            # cascade COST: for every OTHER resource this scale drives negative,
            # add the cheapest single-step time to scale that resource. Cascading
            # onto a cheap-to-scale resource (brick: grass brick_kilns on clay
            # surplus) costs far less than onto an expensive one (stone: a single
            # tile-locked quarry at deep exponential floors), so a surplus-fed
            # scrap source wins over a stone-bound one. Unfixable cascade = huge.
            casc = 0.0
            for r2, v in net_with(a).items():
                if r2 != R and v < 1e-9:
                    casc += min((o[3] for o in boost_for(r2, net)), default=1e12)
            score = dR / (tb + casc + 1e-9)
            cands.append((score, dR, a, lbl))
        if not cands:
            return None
        cands.sort(reverse=True)
        return cands[0][2], cands[0][3]

    def neg_scale(action, net):
        """If `action` would drive a resource net-negative, return (scale_action,
        label, R) to raise that producer first; else None."""
        neg = sorted(r for r, v in net_with(action).items() if v < 1e-9)
        if not neg:
            return None
        b = best_scale(neg[0], net, gated=False)
        return (b[0], b[1], neg[0]) if b is not None else (None, None, neg[0])

    def _apply_sim(sim, a):
        """Mutate a `placed`-shaped copy by a place / upgrade-lowest action."""
        typ = a[1]
        if a[0] == "place":
            sim[typ].append(0)
        else:
            idx = min(range(len(sim[typ])), key=lambda i: sim[typ][i])
            sim[typ][idx] += 1

    def resolve_scale(want, net):
        """Smallest atomic set of prerequisite actions (producer upgrades, coal
        furnaces, windmills) such that applying them ALL and then `want` leaves
        EVERY resource rate strictly positive. Returns:
          []    -> `want` is already safe; apply it directly.
          [..]  -> apply these first (upstream-first order, each safe as applied).
          None  -> some negative has no scalable producer (caller defers/blocks).
        Computed by SIMULATION: copy `placed`, apply `want`, then repeatedly fix
        the single most-starved resource (upgrade its simplest producer / add a
        furnace for heat / a windmill for brownout) until the simulated state has
        no rate <= 0. Simulating the CUMULATIVE state (cluster bonus + collateral
        input draw included) is what resolves cluster-coupling cycles — no ping-pong
        and no collateral negative, because nothing is returned until the whole
        simulated batch is positive. Discovery runs consumer->extractor, so the
        list is reversed to apply extractors first (every intermediate stays > 0)."""
        sim = {k: list(v) for k, v in placed.items()}
        _apply_sim(sim, want)
        order = []
        for _ in range(600):
            # HEAT: a heat consumer beyond furnace capacity (§5.2) idles AND steals a
            # slot from an existing one -> add a furnace (no recipe, always safe).
            if needs_furnace(sim):
                a = ("place", "coal_furnace")
                order.append(a); _apply_sim(sim, a); continue
            net2 = net_rates(sim)[0]
            negs = sorted(r for r, v in net2.items() if v < 1e-9)
            if not negs:
                return order[::-1]
            # POWER: brownout (pf<1) throttles powered producers while furnace
            # coal-burn isn't, so it can drive a resource negative -> add a windmill.
            if power_state(sim)[1] > power_state(sim)[0] + 1e-9:
                a = ("place", "windmill")
                order.append(a); _apply_sim(sim, a); continue
            r = negs[0]
            prods = [n for n in BUILDINGS if BUILDINGS[n]["out"].get(r, 0) > 0 and sim[n]]
            if not prods:
                return None            # nothing produces r -> caller defers/blocks
            # scale the SIMPLEST producer (fewest recipe inputs -> least collateral;
            # prefers a pure extractor over an input-hungry scrapper). PREFER PLACING
            # a new one (flat cost, adds cluster bonus) over deep-upgrading a single
            # building — floor cost scales 1.15^(floor-10), so deep upgrades make the
            # batch cost astronomical and trigger endless crate provisioning.
            typ = min(prods, key=lambda n: len(BUILDINGS[n]["in"]))
            if len(sim[typ]) < TERRAIN_CAPS[typ]:
                a = ("place", typ)
            else:
                idx = min(range(len(sim[typ])), key=lambda i: sim[typ][i])
                a = ("upgrade", typ, sim[typ][idx] + 2)
            order.append(a); _apply_sim(sim, a)
        return None                    # didn't converge in the step budget -> defer

    def crate_step(cost):
        """If `cost` exceeds a resource's cap, return (crate_action, label) to raise
        it — upgrade the lowest crate below floor 11, else build a new one; else None."""
        cr = crate_needed(cost, inv, crate_for)
        if cr is None:
            return None
        upgradable = [L for L in crate_for.get(cr, []) if L < 10]
        if upgradable:
            return ("crate_up", cr, min(upgradable) + 2), f"crate^[{cr}]"
        return ("crate", cr), f"crate[{cr}]"

    def needs_furnace(p):
        return n_heat(p) > heat_capacity(p)

    def show_breakdown():
        print("    Final buildings (count, by displayed floor):")
        for n, fl in placed.items():
            if not fl:
                continue
            extra = ""
            if n == "windmill":
                extra = f"   [{windmill_power(fl):.0f} kW for {demand} kW demand]"
            print(f"      {n:<18} x{len(fl):<3}  {floor_breakdown(fl)}{extra}")
        if crate_for:
            total = sum(len(v) for v in crate_for.values())
            print(f"      {'crate':<18} x{total:<3}  "
                  + "; ".join(f"{r}:[{floor_breakdown(fl)}] cap->{nominal_cap(r, crate_for):.0f}"
                              for r, fl in sorted(crate_for.items())))
        final_net = net_rates(placed)[0]
        print("\n    Final inventory (net rate /h  /  stock  /  cap):")
        for r in sorted(inv):
            if abs(inv[r]) < 1e-6 and abs(final_net.get(r, 0)) < 1e-12:
                continue
            cap_r = max(nominal_cap(r, crate_for), inv[r])
            print(f"      {r:<16} {final_net.get(r, 0) * 3600:>+10.3f}/h  "
                  f"{inv[r]:>10.2f} / {cap_r:.0f}")

    step = 0
    while True:
        step += 1
        if step % 200 == 0:  # [TEMP DIAG]
            ncr = sum(len(v) for v in crate_for.values())
            print(f"[STEP {step}] t={fmt_dur(t)} placed={sum(len(v) for v in placed.values())} "
                  f"crates={ncr} remaining={len(remaining)}", flush=True)
        if step > 10000:
            print("!! step cap hit — aborting"); break
        net, pf = net_rates(placed)
        gross = net_rates(placed, production_only=True)[0]  # §4.9 throttle-aware affordability
        supply, dmd = power_state(placed)

        # 1) keep placed consumers powered (on-demand windmill add/upgrade)
        if dmd > supply + 1e-9:
            act, label = windmill_decision(net)
            if act is not None:
                throttle = advance_and_apply(act, net)
                schedule.append((t, label, "windmill", pf,
                                 f"{supply:.0f}->{windmill_power(placed['windmill']):.0f}kW",
                                 throttle))
                continue
            # else: power is blocked (can't afford either) -> fall through to report

        # 1.5) keep heat consumers served: auto-place a coal furnace when the
        #      placed heat consumers outrun furnace capacity (FURNACE_FANOUT each).
        if needs_furnace(placed):
            fa = ("place", "coal_furnace")
            if time_to_afford(inv, BUILDINGS["coal_furnace"]["cost"], net, gross=gross) < float("inf"):
                sc, sl, R = neg_scale(fa, net) or (None, None, None)
                if sc is not None:
                    throttle = advance_and_apply(sc, net)
                    schedule.append((t, f"{sl}!", sc[1], pf, f"(scale {R} for heat)", throttle))
                    continue
                throttle = advance_and_apply(fa, net)
                schedule.append((t, "add", "coal_furnace", pf, "(heat source)", throttle))
                continue
            # else: can't afford a furnace yet -> heat consumers idle until we can.

        # 1.6) §8.7 lift the exhaust-scrubber soft gate: auto-place a scrubber when a
        #      high-emission building (coke_oven) outruns scrubber capacity, so it
        #      runs at full rate instead of ×scrub_mul. SOFT — if we can't afford one
        #      yet, the building just keeps running degraded (no block).
        if n_scrub(placed) > scrub_capacity(placed):
            sa = ("place", "exhaust_scrubber")
            if time_to_afford(inv, BUILDINGS["exhaust_scrubber"]["cost"], net, crate_for, gross) < float("inf"):
                cr = crate_needed(BUILDINGS["exhaust_scrubber"]["cost"], inv, crate_for)
                if cr is None:
                    throttle = advance_and_apply(sa, net)
                    schedule.append((t, "add", "exhaust_scrubber", pf, "(scrub coke_oven)", throttle))
                    continue
            # else: can't afford yet -> coke_oven runs at scrub_mul until we can.

        if not remaining:
            break

        # 2.0) BOOTSTRAP A SCRAP PRODUCER (best_scale-driven). The {name}_scrapper
        #      buildings are the only scrap source and are NOT in TARGET, so a
        #      required consumer whose recipe input is scrap (steel_mill_scrap)
        #      can never become `ready` until one is placed. When a needed input
        #      has no producer AND no TARGET building makes it, place the BEST next
        #      producer via best_scale (it ranks every feasible scrapper by
        #      Δscrap-rate per time+cascade), scaling that scrapper's own
        #      prerequisites first via resolve_scale. Dormant until a feasible
        #      scrapper exists (its basket producers placed + fresh_water flowing).
        missing = sorted({r for a in remaining if a[0] == "place"
                          for r in BUILDINGS[a[1]]["in"]
                          if not has_producer(r) and not target_can_produce(r)})
        bootstrapped = False
        for R in missing:
            b = best_scale(R, net, gated=False)
            if b is None:
                continue
            rs = resolve_scale(b[0], net)
            if rs is None:
                continue
            acts = rs + [b[0]]   # apply b[0] WITH its prereqs (same atomic-batch rule)
            total = {}
            for a in acts:
                for r, n in cost_of(a).items():
                    total[r] = total.get(r, 0) + n
            cs = crate_step(total)
            if cs is not None:
                ca, clabel = cs
                if time_to_afford(inv, cost_of(ca), net, crate_for, gross) == float("inf"):
                    continue
                throttle = advance_and_apply(ca, net)
                schedule.append((t, "add", clabel, pf, f"(cap for {b[0][1]})", throttle))
                bootstrapped = True
                break
            if time_to_afford(inv, total, net, crate_for, gross) == float("inf"):
                continue
            throttle = advance_and_apply(acts, net)
            schedule.append((t, f"batch[{len(acts)}]" if len(acts) > 1 else acts[0][0],
                             b[0][1], pf, f"(bootstrap {R})", throttle))
            bootstrapped = True
            break
        if bootstrapped:
            continue

        # 2) ordering. (a) TOPOLOGICAL: only place a building once its RECIPE
        #    INPUTS each have a placed producer (input producers before their
        #    consumers — limestone_quarry before limekiln before cement_mill).
        #    (b) PRODUCER-PRIORITY: among ready actions, first place producers of
        #    a still-unproduced resource that something needs (placement-cost OR
        #    recipe-input), before its starting stock drains.
        def ready(a):
            return a[0] != "place" or all(has_producer(r) for r in BUILDINGS[a[1]]["in"])
        ready_actions = [a for a in remaining if ready(a)]
        undeferred = [a for a in ready_actions if a not in deferred]
        if undeferred:
            pool_base = undeferred
        elif not ready_actions:
            pool_base = remaining   # nothing topologically ready -> fall back
        else:
            pool_base = []          # all ready actions deferred -> stuck this round (block below)
        needed = set()
        for a in remaining:
            needed.update(cost_of(a).keys())
            if a[0] == "place":
                needed.update(BUILDINGS[a[1]]["in"])
        critical = [a for a in pool_base if a[0] == "place"
                    and any(r in needed and not has_producer(r) for r in BUILDINGS[a[1]]["out"])]
        pool = critical or pool_base
        best_t, choice = float("inf"), None
        for a in pool:
            tt = time_to_afford(inv, cost_of(a), net)
            if choice is None or tt < best_t:   # pick one even if all are inf-time
                best_t, choice = tt, a

        # A finite best_t is great. If it's inf, DON'T block — a placement-cost
        # resource is operationally exhausted (e.g. blast_furnace's stone eaten by
        # the scrap chain); fall through so the bottleneck-attack (2.5) scales that
        # producer. Only truly block when the pool is empty (everything deferred).
        if choice is None:
            # [TEMP DIAG] what's ready-but-deferred, and why?
            print(f"[DIAG-STUCK] remaining={sorted(set(remaining))}")
            print(f"[DIAG-STUCK] deferred={sorted(deferred)}")
            for a in sorted(set(remaining)):
                if not ready(a):
                    continue
                ttc_a = time_to_afford(inv, cost_of(a), net, crate_for, gross)
                rs_a = resolve_scale(a, net)
                cn = crate_needed(cost_of(a), inv, crate_for)
                print(f"[DIAG-STUCK]   {a}: ttc={fmt_dur(ttc_a)} "
                      f"resolve_scale={rs_a} crate_needed={cn}")
                pw = power_state(placed_with(a))
                negs = {r: round(v * 3600, 2) for r, v in net_with(a).items() if v < 1e-9}
                print(f"[DIAG-STUCK]     needs_furnace={needs_furnace(placed_with(a))} "
                      f"placed_with_power(sup={pw[0]:.0f},dem={pw[1]:.0f}) "
                      f"cur_sup={power_state(placed)[0]:.0f} "
                      f"windmill={windmill_decision(net)} negs={negs}")
                for rneg in negs:
                    bf = boost_for(rneg, net)
                    print(f"[DIAG-STUCK]       boost_for({rneg}) -> "
                          f"{[(c[0], round(c[2], 6), fmt_dur(c[3])) for c in bf]} "
                          f"| net={net.get(rneg, 0.0)*3600:+.4f}/h "
                          f"gross={gross.get(rneg, 0.0)*3600:+.4f}/h")
            print("\n!! BLOCKED — cannot afford any remaining target / power action.")
            blockers = {}
            for a in remaining:
                for r, need in cost_of(a).items():
                    if need - inv.get(r, 0) > 0 and net.get(r, 0) <= 1e-12:
                        blockers[r] = need - inv.get(r, 0)
            if dmd > supply + 1e-9:
                print(f"     power short ({dmd:.0f}>{supply:.0f}kW) and cannot afford a windmill")
            for r, sh in sorted(blockers.items()):
                print(f"     need {fmt_dur(sh) if sh==float('inf') else f'{sh:.0f} more'} {r} but nothing produces it yet")
            print(f"\n   reached at t={fmt_dur(t)}:\n")
            show_breakdown()
            return

        # 2.5) BOTTLENECK-ATTACK — resolve the action to actually take. Usually
        #      `choice`, but if `choice` is gated by a produced resource R, attack
        #      R: PLACE-TO-CAP FIRST (placements are cheaper per unit output and
        #      add cluster bonus), and only UPGRADE the lowest producer once R is
        #      at its terrain cap (payback-gated).
        # 2.5) DEMAND-DRIVEN SCALING. Scale a producer ONLY to afford the next
        #      required `choice` — never proactively — UNLESS the scale pays off in
        #      time for THIS step: tb + stepdef/(rate+dR) < stepdef/rate. (And always
        #      scale if the gating resource has zero production at all.) This is what
        #      keeps it convergent — no speculative stacking of producers.
        action, label, note = choice, choice[0], ""
        ttc = time_to_afford(inv, cost_of(choice), net, crate_for, gross)
        gate = binding_resources(inv, cost_of(choice), net)
        if gate:
            R = gate[0]
            rate = net.get(R, 0.0)
            if rate <= 1e-12:
                rate = gross.get(R, 0.0)
            stepdef = max(0.0, cost_of(choice).get(R, 0) - inv.get(R, 0))
            best, bscore = None, 0.0
            for a, lbl, dR, tb in boost_for(R, net):
                if rate <= 1e-12:
                    worth = True                      # no production -> must scale
                else:
                    worth = tb + stepdef / (rate + dR) < stepdef / rate  # pays off for next step
                if not worth:
                    continue
                # tie-break by Δrate per (time + cascade cost): a scale that drives
                # ANOTHER resource negative costs the cheapest way to fix that too.
                casc = 0.0
                for r2, v in net_with(a).items():
                    if r2 != R and v < 1e-9:
                        casc += min((o[3] for o in boost_for(r2, net)), default=1e12)
                score = dR / (tb + casc + 1e-9)
                if best is None or score > bscore:
                    best, bscore = (a, lbl), score
            if best is not None:
                action, label, note = best[0], best[1], f"(scale {R})"

        # 2.55) STORAGE BEFORE ACCUMULATION: if `action`'s cost exceeds a resource's
        #       cap, raise it (§4.6) — UPGRADE a crate to floor 11 before a new one.
        cs = crate_step(cost_of(action))
        if cs is not None:
            ca, clabel = cs
            if time_to_afford(inv, cost_of(ca), net, crate_for, gross) < float("inf"):
                throttle = advance_and_apply(ca, net)
                schedule.append((t, "add", clabel, pf, f"(cap for {action[1]})", throttle))
                continue
            print(f"\n!! cannot raise cap @ {fmt_dur(t)}: crate unaffordable.")
            return

        # If we're still on the required `choice` and it's unaffordable with nothing
        # worth scaling (a needed resource has no producer at all), defer it.
        if action == choice and ttc == float("inf"):
            if choice in remaining:
                deferred.add(choice)
                continue
            print(f"\n!! BLOCKED — can't afford or scale for next: {choice} @ {fmt_dur(t)}\n")
            show_breakdown()
            return

        # 2.65) HEAT BEFORE PLACEMENT: a requiresHeat consumer needs a furnace to
        #       serve it (§5.2). If placing `action` outruns furnace capacity, add a
        #       coal furnace first (when affordable); else place anyway and let it
        #       idle (rate 0) until a furnace is built reactively in 1.5.
        if action[0] == "place" and BUILDINGS[action[1]].get("requiresHeat") \
                and needs_furnace(placed_with(action)):
            fa = ("place", "coal_furnace")
            if time_to_afford(inv, BUILDINGS["coal_furnace"]["cost"], net, gross=gross) < float("inf"):
                sc, sl, R = neg_scale(fa, net) or (None, None, None)
                if sc is not None:
                    throttle = advance_and_apply(sc, net)
                    schedule.append((t, f"{sl}!", sc[1], pf, f"(scale {R} for heat)", throttle))
                    continue
                throttle = advance_and_apply(fa, net)
                schedule.append((t, "add", "coal_furnace", pf,
                                 f"(heat before {action[1]})", throttle))
                continue
            # else: can't afford a furnace -> place the consumer anyway (idles).

        # 2.7) POWER BEFORE PLACEMENT (best-effort): build energy BEFORE placing a
        #      consumer when we can afford it. If we can't afford a windmill yet,
        #      place anyway — the §5 BROWNOUT (pf = available/consumed, applied to
        #      every power-drawing recipe in net_rates) throttles production until
        #      power catches up, rather than blocking.
        if action[0] == "place" and BUILDINGS[action[1]]["power"] < 0:
            need = power_state(placed_with(action))[1]
            if need > supply + 1e-9:
                wact, wlabel = windmill_decision(net)
                if wact is not None:
                    throttle = advance_and_apply(wact, net)
                    schedule.append((t, wlabel, "windmill", pf,
                                     f"{supply:.0f}->{windmill_power(placed['windmill']):.0f}kW",
                                     f"(power before {action[1]})"))
                    continue
                # else: can't afford power now -> place anyway, run under brownout.

        # 2.8) NO-NEGATIVE-RATE INVARIANT. Never apply an action that drives any
        #      resource's net rate below 0 — a deficit drains stock and stalls its
        #      chain. resolve_scale returns the producer-scale to do FIRST so
        #      `action` starves nothing (recursing toward the extractors), or
        #      `action` itself when already balanced, or None when the chain can't
        #      be balanced greedily (defer the consumer; block if not deferrable).
        #      This is the single choke point for BOTH required placements and the
        #      2.5 bottleneck-attack scales — power stays soft (brownout, above),
        #      material flow stays hard (scale-first, here).
        rs = resolve_scale(action, net)
        if rs is None and action != choice:
            # The action is a SPECULATIVE 2.5 scale (a producer boost to afford
            # `choice` faster) that can't be applied without starving a shared
            # input. The scale is an optimization, not a necessity — abandon it
            # and fall back to the required `choice`, letting its inputs
            # accumulate at the current (still non-negative) rates.
            action, label, note = choice, choice[0], ""
            rs = resolve_scale(action, net)
        if rs is None:
            # `choice` itself can't be placed without driving a resource negative
            # and no producer can be scaled to cover it. Defer (retry after other
            # progress); block only once every ready action is exhausted.
            if choice in remaining:
                deferred.add(choice)
                continue
            print(f"\n!! BLOCKED — can't scale producers to feed {choice[1]} "
                  f"without starving a shared input @ {fmt_dur(t)}\n")
            show_breakdown()
            return
        # Apply `action` TOGETHER WITH its prerequisites `rs` as ONE ATOMIC batch.
        # `want` MUST be in the batch: the fixpoint sized the prereqs with `want`
        # present (e.g. a chemistry building raises the shared cluster bonus, so
        # limekiln produces more quicklime). Applying prereqs WITHOUT `want` would
        # leave the cluster bonus lower and a sibling resource net-negative. So the
        # observed (settled) state matches the fixpoint's positive sim only when the
        # whole batch — prereqs + want — lands at one instant. Raise storage first if
        # the combined cost exceeds a cap; defer the consumer if it can't be paid.
        batch = rs + [action]
        total = {}
        for a in batch:
            for r, n in cost_of(a).items():
                total[r] = total.get(r, 0) + n
        cs = crate_step(total)
        if cs is not None:
            ca, clabel = cs
            if time_to_afford(inv, cost_of(ca), net, crate_for, gross) < float("inf"):
                throttle = advance_and_apply(ca, net)
                schedule.append((t, "add", clabel, pf, f"(cap for {action[1]})", throttle))
                continue
            if choice in remaining:
                deferred.add(choice)
                continue
        if time_to_afford(inv, total, net, crate_for, gross) == float("inf"):
            if choice in remaining:
                deferred.add(choice)
                continue
            print(f"\n!! BLOCKED — can't afford to place/feed {choice[1]} @ {fmt_dur(t)}\n")
            show_breakdown()
            return
        was_required = action in remaining
        throttle = advance_and_apply(batch, net)
        lbl = f"batch[{len(batch)}]" if len(batch) > 1 else label
        schedule.append((t, lbl, action[1], pf, note or f"(feed {action[1]})", throttle))
        if was_required:
            remaining.remove(action)
        deferred = set()  # progress made -> let any parked consumers retry

    print("Schedule (cumulative time -> action):")
    print(f"   {'time':>10}  {'action':<19} {'pf':>5}  {'throttled by':<14} {'power'}")
    for (ts, kind, name, pf, note, throttle) in schedule:
        act = f"{kind} {name}"
        print(f"   {fmt_dur(ts):>10}  {act:<19} {pf:>5.2f}  {throttle:<14} {note}")
    print(f"\n>>> Full target build placed in: {fmt_dur(t)}")
    show_breakdown()


if __name__ == "__main__":
    main()
