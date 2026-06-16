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
PLAN_STEP_CAP = 4000
PARALLEL_BUILD_SLOTS = 1       # bootstrap: 1 + Robotics(0) + structural(0)
COAL_CYCLE_SEC = 30            # §5.2 furnace fuel-burn cycle
MIN_HEAT_FACTOR = 0.1          # §5.2 below this a heat consumer fully stalls
_FAIL = [""]

# §9.3 base construction time per tier (ms in game → seconds here).
BASE_CONSTRUCTION_S_BY_TIER = {1: 30, 2: 120, 3: 300, 4: 900, 5: 1800, 6: 3600}

# Amortize big ONE-TIME placement costs of GRASS goods into steady demand so
# the solve sizes the steel chain; tile-locked goods are left to the executor's
# payback gate (see v2 rationale — kept).
BUILD_TIME_S = 7300 * 24 * 3600

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
                   "clusters": True, "tier": 2, "requiresHeat": True, "heat_demand_kw": 60},
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
    "well": 4, "coastal_pump": 4,
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
    "concrete_plant": 1, "assembler": 1, "steel_mill_scrap": 1, "brick_kiln": 1,
    "beam_mill": 1, "pipe_mill": 1, "coke_oven": 1, "blast_furnace": 1,
    "air_separator": 1, "steel_mill": 1,
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
        for i, f in enumerate(floors):
            hf = heat_factor.get((name, i), 1.0) if d.get("requiresHeat") else 1.0
            if d.get("requiresHeat") and hf < MIN_HEAT_FACTOR:
                continue  # full heat stall → contributes nothing
            mul = (1 + f) * (1 + CLUSTER_RATE * (kcat - (1 + f))) if kcat is not None else (1 + f)
            base_rate = mul * hf / cyc            # cycles/sec for this instance
            produces = {r: u * base_rate * scale_pf for r, u in d["out"].items() if u > 0}
            consumes = {r: u * base_rate * scale_pf for r, u in d["in"].items() if u > 0}
            specs.append({"produces": produces, "consumes": consumes})
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
    # coal burn fold
    if heat_served and not production_only:
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
        if lo < FLOOR_SOFT_CAP:
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
    n_clear = ceil((EPS - cur) / dR) if dR > 1e-12 else 1
    n = max(1, min(int(n_clear), SCALE_JUMP_CAP))
    acts = [a1]
    for _ in range(n - 1):
        a = balanced_scale(s, typ)
        if a is None:
            break
        acts.append(a)
        mutate(s, {}, a)
    return acts


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
    sim = state.copy_placed()
    cf = {k: list(v) for k, v in state.crate_for.items()}
    inv = state.inv
    plan = [want]
    mutate(sim, cf, want)
    for _ in range(PLAN_STEP_CAP):
        gated = [r for r in BUILDINGS[want[1]]["in"] if not has_producer(sim, r)]
        if gated:
            acts = scale_action(sim, inv, cf, gated[0])
            if acts is None:
                _FAIL[0] = f"no producer for input {gated[0]}"
                return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        hf = needs_heat_fix(sim)
        if hf is not None:
            plan.append(hf); mutate(sim, cf, hf); continue
        net = net_rates(sim, inv, cf)[0]
        # A resource pinned at its storage CAP (full/surplus) legitimately nets
        # ~0 under the exact solver (producers throttle to consumer draw) — that
        # is NOT a deficit, so exclude it.  Starter stock above the normal cap
        # (e.g. 600 wood vs cap 100) would otherwise look "starved" forever.
        capped = {r for r in net if inv.get(r, 0.0) >= nominal_cap(r, cf) - STOCK_BOUNDARY_EPS}
        negs = sorted(r for r, v in net.items() if v < EPS and r not in capped)
        if negs:
            r = negs[0]
            sup, dem = power_state(sim)
            brownout = dem > sup + 1e-9
            full = net_rates(sim, inv, cf, force_full_power=True)[0] if brownout else net
            if brownout and full.get(r, 0.0) >= EPS:
                acts = [balanced_scale(sim, "windmill")]
            else:
                acts = scale_action(sim, inv, cf, r)
                if acts is None:
                    _FAIL[0] = f"can't scale starved {r}"
                    return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        a = payback_scale(sim, cf, inv, cost_of(want))
        if a is not None:
            plan.append(a); mutate(sim, cf, a); continue
        return plan
    _FAIL[0] = (f"step cap {PLAN_STEP_CAP} hit; still negative: "
                f"{sorted(x for x, v in net_rates(sim, inv, cf)[0].items() if v < EPS)[:6]}")
    return None


# ====================================================================
# COMMIT
# ====================================================================
def advance(state, cost):
    net = net_rates(state.placed, state.inv, state.crate_for)[0]
    gross = net_rates(state.placed, state.inv, state.crate_for, production_only=True)[0]
    dt = time_to_afford(state.inv, cost, net, state.crate_for, gross)
    if dt == float("inf"):
        return False
    for r in set(net) | set(cost):
        rate = net.get(r, 0.0)
        if rate <= 1e-12 and (cost.get(r, 0) - state.inv.get(r, 0)) > 0:
            rate = gross.get(r, 0.0)
        before = state.inv.get(r, 0)
        after = before + rate * dt
        if rate > 0:
            after = min(after, max(nominal_cap(r, state.crate_for), before))
        state.inv[r] = after
    state.t += dt
    for r, n in cost.items():
        state.inv[r] = state.inv.get(r, 0) - n
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
    net = net_rates(state.placed, state.inv, state.crate_for)[0]
    bad = {r: round(v * 3600, 4) for r, v in net.items() if v < -1e-6}
    if bad:
        raise AssertionError(f"NEGATIVE rate after {label} @ {fmt_dur(state.t)}: {bad}")


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
            if len(state.placed[name]) == 0:
                for r in BUILDINGS[name]["out"]:
                    if r in NEEDED_RES and not has_producer(state.placed, r):
                        return 0
            return 1
        oi = {n: i for i, n in enumerate(TARGET)}
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
            print(f"   [{placed_n:>2}/{len(TARGET)}] {fmt_dur(state.t):>12}  place {name:<22} "
                  f"(+{len(plan) - 1} fixes)", flush=True)
            deferred.clear()
            progressed = True
            break

        if not progressed:
            print(f"\n!! BLOCKED @ {fmt_dur(state.t)} — every ready target deferred. "
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
        print(f"   {fmt_dur(ts):>12}  place {name:<22} (+{nfix} balancing actions)")
    print(f"\n>>> Full target build placed in: {fmt_dur(state.t)}  "
          f"({sum(len(v) for v in state.placed.values())} buildings, "
          f"{sum(len(v) for v in state.crate_for.values())} crates)\n")
    show_breakdown(state)


if __name__ == "__main__":
    main()
