#!/usr/bin/env python3
"""Robot Islands — bootstrap build PLANNER (v2, clean rebuild).

Same DEFINITIONS and pure rate-math as v1 (BUILDINGS / TERRAIN_CAPS / TARGET /
net_rates / cluster / heat / power / caps). The CONTROL FLOW is rebuilt around a
single invariant and one shared mutation primitive:

  INVARIANT: after every committed step, EVERY resource's net rate is strictly
  positive ( > EPS ). Never observe a <= 0 rate.

How v1 broke it: ~9 separate decision sites each provisioned heat/power/storage/
producers their own way, and the SIMULATION that "proved" a plan safe applied
actions through different code (and a different order) than the COMMIT that
applied them for real. sim-state != commit-state => a "verified positive" plan
landed on a negative state. Patching one site moved the break to another.

v2 fix — ONE path, ONE primitive:
  * `mutate(placed, crate_for, action)` is the ONLY thing that changes building
    state. Both planning and committing call it. So the state a plan was proven
    safe on is byte-for-byte the state that gets committed.
  * `plan_for(state, want)` SIMULATES on a copy: apply `want`, then repeatedly
    add the one cheapest fix for the most-starved resource (place a producer /
    coal furnace / windmill / scrubber) until the simulated rates are all > EPS.
    It returns the EXACT ordered action list it applied (want first), or None.
  * `commit(state, plan)` provisions storage crates for the plan's combined cost,
    advances time, then applies the SAME list via the SAME `mutate`. Committed
    state == simulated state => rates are all > EPS, guaranteed, every time.

The main loop is then trivial: pick a ready, still-needed TARGET building, plan
it, commit it. No special cases — heat, power, storage, scrap faucets, and
cluster-coupling are all just "fixes the simulation discovered."
"""

from math import ceil
import os
import json

SEED_PATH = os.environ.get("RI_SEED")
SEED_MODE = bool(SEED_PATH)

EPS = 1e-9                 # a rate must exceed this to count as "positive"
CLUSTER_RATE = 0.05
PLAN_STEP_CAP = 3000       # max fixes the simulation will add before giving up
_FAIL = [""]               # [diag] why the last plan_for returned None
# Flow-solve sizing: one-time placement costs are amortized over this wall-time as
# a steady demand, so big costs (steel_beam 30000, concrete 20000) get real
# producer capacity instead of a trickle. Smaller -> bigger/faster factory.
# ============================ OPEN PROBLEM (steel apex) ============================
# 25/27 targets build cleanly (no negatives ever, fast). blast_furnace + steel_mill
# (pig-iron route) are the holdouts. ROOT: their 30000/25000 steel_beam PLACEMENT
# drives a steel -> steel_mill_scrap -> scrap -> scrapper chain. scrappers are
# 'special' (NO cluster bonus -> linear supply), but their downstream consumers and
# the chemistry producers they lean on (concrete_plant) ARE clustered, so the chain's
# STONE draw is amplified ×cluster-bonus while quarry (cap-1, no bonus) is not ->
# quarry is pushed to ~fl100 (1.15^90 -> ~10^11 stone, "unaffordable").
# Window tradeoff (BUILD_TIME_S): short window -> chain sized big -> balances but
# quarry floor explodes; long window -> chain too small -> scrap can't balance
# (plan_for step-cap). NEXT: give the scaling a CASCADE COST (v1 idea) — refuse to
# scale a producer whose draw cascades onto an expensive tile-locked resource
# (stone), so the steel chain self-limits and steel_beam accumulates slowly instead.
BUILD_TIME_S = 7300 * 24 * 3600    # 20-yr window: shrinks the amortized steel chain
                                   # so its (cluster-amplified) coal/stone draw fits
                                   # the tile-locked extractors under TILE_FLOOR_CAP
GRASS_CAP = 50                     # terrain cap >= this -> scale by COUNT, else by FLOOR
GRASS_INSTANCE_FLOOR = 10          # realize grass producers as ~this displayed floor

STARTING_INVENTORY = {
    "stone": 1200, "wood": 600, "iron_ore": 30, "coal": 80, "iron_ingot": 60,
    "bolt": 25, "limestone": 15, "saltwater_cell": 4, "foundation_kit": 1,
    "scrap": 5000,
}

# --- DEFINITIONS: building catalog (level-1 baseline) — unchanged from v1 ---
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
    "coal_furnace": {"cost": {"stone": 50, "iron_ingot": 20, "wood": 30}, "power": 0,
                   "cycle_s": None, "in": {}, "out": {}, "category": "special",
                   "clusters": False, "coal_per_cycle": 1},
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
    "coke_oven":  {"cost": {"clay": 15000, "stone": 500, "pipe": 100}, "power": -60,
                   "cycle_s": 214998.3, "in": {"coal": 10},
                   "out": {"coke": 7, "wood_tar": 0.4, "hydrogen": 0.5, "co2": 1,
                           "refinery_gas": 1.1}, "category": "smelting",
                   "clusters": False, "requiresHeat": True, "scrub_mul": 0.5},
    "exhaust_scrubber": {"cost": {"steel_beam": 80, "concrete": 1500, "gear": 30,
                            "pipe": 50, "clay": 500}, "power": -20, "cycle_s": None,
                   "in": {}, "out": {}, "category": "special", "clusters": False},
    "blast_furnace": {"cost": {"steel_beam": 30000, "clay": 25000, "stone": 2000},
                   "power": -100, "cycle_s": 6217.4,
                   "in": {"iron_ore": 35, "coke": 18, "limestone": 10},
                   "out": {"pig_iron": 20, "slag": 6, "co2": 35},
                   "category": "smelting", "clusters": False, "requiresHeat": True},
    "air_separator": {"cost": {"concrete": 2000, "glass": 400, "copper_ingot": 300,
                            "brick": 800}, "power": -300, "cycle_s": 1960.1, "in": {},
                   "out": {"nitrogen": 75.5, "oxygen": 23.2, "argon": 1.3},
                   "category": "chemistry", "clusters": False},
    "steel_mill": {"cost": {"steel_beam": 25000, "clay": 8000, "stone": 2000},
                   "power": -120, "cycle_s": 4222.6,
                   "in": {"pig_iron": 100, "quicklime": 7, "oxygen": 9},
                   "out": {"steel": 85, "slag": 23, "co": 7, "co2": 1},
                   "category": "smelting", "clusters": False, "requiresHeat": True},
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

TERRAIN_CAPS = {
    "logger": 4, "quarry": 1, "quartz_mine": 1, "iron_mine": 1, "coal_mine": 1,
    "clay_pit": 1, "windmill": 999, "smelter": 999, "workshop": 999,
    "limestone_quarry": 1, "copper_mine": 1, "copper_smelter": 999, "sand_pit": 1,
    "glassworks": 999, "well": 4, "coastal_pump": 4, "coal_furnace": 999,
    "limekiln": 999, "cement_mill": 999, "concrete_plant": 999, "crate": 999,
    "assembler": 999, "steel_mill_scrap": 999, "brick_kiln": 999, "beam_mill": 999,
    "pipe_mill": 999, "coke_oven": 999, "exhaust_scrubber": 999, "blast_furnace": 999,
    "air_separator": 999, "steel_mill": 999,
}

# --- AUTO-GENERATED scrap faucets: one {name}_scrapper per base building ---
# Models the §6.7 + §14 place+demolish recycling loop on the building's basket:
#   net consumed = n - floor(n/2) per resource;  minted scrap = floor(0.3 * Σ basket)
# cycle_s tuned so a floor-1 scrapper's scrap/s == one floor-1 steel_mill_scrap's
# scrap intake. Scrappers are the only scrap source; the planner places them as a
# normal producer-fix when something needs scrap. `_base` captured before generation.
_SMS = BUILDINGS["steel_mill_scrap"]
_SCRAP_REF_PER_S = _SMS["in"]["scrap"] / _SMS["cycle_s"]
for _base in list(BUILDINGS):
    _cost = BUILDINGS[_base]["cost"]
    _scrap_out = sum(_cost.values()) * 3 // 10
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

# --- TARGET: count per building (floor 1 = base). The MINIMUM set that must EXIST;
# the planner places extra producers as needed to keep every rate positive. ---
TARGET = {
    "logger": 4, "quarry": 1, "quartz_mine": 1, "iron_mine": 1, "coal_mine": 1,
    "clay_pit": 1, "smelter": 1, "workshop": 1, "limestone_quarry": 1,
    "copper_mine": 1, "copper_smelter": 1, "sand_pit": 1, "glassworks": 1,
    "well": 1, "coastal_pump": 1, "limekiln": 1, "cement_mill": 1,
    "concrete_plant": 1, "assembler": 1, "steel_mill_scrap": 1, "brick_kiln": 1,
    "beam_mill": 1, "pipe_mill": 1, "coke_oven": 1, "blast_furnace": 1,
    "air_separator": 1, "steel_mill": 1,
}

# Resources that something actually uses — as a recipe input OR a placement cost.
# (Excludes dead-end byproducts like quartz/saltwater/slag, whose producers are
# still in TARGET but needn't be bootstrapped early.)
NEEDED_RES = {r for b in BUILDINGS.values()
              for r in list(b["in"]) + list(b["cost"])}

# Resources whose ONLY producers are tile-locked (terrain cap < GRASS_CAP) — stone,
# clay, wood, the ores, etc. They can't be scaled by count, only by exponential
# floor, so driving one negative is EXPENSIVE to fix. A good scrap faucet avoids
# them; this weights them heavily in scrapper selection.
TILE_LOCKED_RES = {r for b in BUILDINGS for r in BUILDINGS[b]["out"]
                   if all(TERRAIN_CAPS[p] < GRASS_CAP
                          for p in BUILDINGS if BUILDINGS[p]["out"].get(r, 0) > 0)}

FURNACE_FANOUT = 4
HEAT_CYCLE_S = 30
SCRUBBER_FANOUT = 4
DEFAULT_BASE_CAP = 100
RESOURCE_BASE_CAP = {"foundation_kit": 5, "ai_core": 0, "helium_3": 1,
                     "antimatter_propellant": 1}
CRATE_MULT = 5


# ====================================================================
# PURE RATE MATH (identical model to v1) — read-only over a placed dict
# ====================================================================
def cluster_bonus(floors, i):
    K = sum(1 + f for f in floors)
    return 1 + CLUSTER_RATE * (K - (1 + floors[i]))


GRASS_CLUSTER_CATS = {"smelting", "chemistry", "manufacturing"}


def is_clustered(name):
    d = BUILDINGS[name]
    return bool(d.get("clusters")) or d["category"] in GRASS_CLUSTER_CATS


# Precomputed lookups (BUILDINGS is final here) — this is the hot path. Scanning
# all ~75 buildings per recipe-input check was 80% of runtime (profile).
PRODUCERS_OF = {}
for _b in BUILDINGS:
    for _r in BUILDINGS[_b]["out"]:
        PRODUCERS_OF.setdefault(_r, []).append(_b)
_CLUSTERED = {n: is_clustered(n) for n in BUILDINGS}
_CATEGORY = {n: BUILDINGS[n]["category"] for n in BUILDINGS}
_HEAT_B = [n for n in BUILDINGS if BUILDINGS[n].get("requiresHeat")]
_SCRUB_B = [n for n in BUILDINGS if BUILDINGS[n].get("scrub_mul")]


def cluster_K(placed):
    K = {}
    for name, fl in placed.items():
        if not fl or not _CLUSTERED[name]:
            continue
        cat = _CATEGORY[name]
        K[cat] = K.get(cat, 0.0) + sum(1 + f for f in fl)
    return K


def upgrade_cost(name, target_displayed):
    base = BUILDINGS[name]["cost"]
    factor = 0.8 if target_displayed <= 10 else 0.8 * (1.15 ** (target_displayed - 10))
    return {r: ceil(n * factor) for r, n in base.items() if n > 0}


def baseline_cap(r):
    return RESOURCE_BASE_CAP.get(r, DEFAULT_BASE_CAP)


def nominal_cap(r, crate_for):
    if SEED_MODE:
        return 1e15
    base = max(5, baseline_cap(r))
    return baseline_cap(r) + sum(CRATE_MULT * base * (1 + L) for L in crate_for.get(r, []))


def n_heat(placed):
    return sum(len(placed[n]) for n in _HEAT_B)


def heat_capacity(placed):
    return FURNACE_FANOUT * len(placed.get("coal_furnace", []))


def needs_furnace(placed):
    return n_heat(placed) > heat_capacity(placed)


def n_scrub(placed):
    return sum(len(placed[n]) for n in _SCRUB_B)


def scrub_capacity(placed):
    return SCRUBBER_FANOUT * len(placed.get("exhaust_scrubber", []))


def needs_scrubber(placed):
    return n_scrub(placed) > scrub_capacity(placed)


def inputs_satisfied(name, placed):
    """A consumer runs only once every recipe-input has a placed producer."""
    for r in BUILDINGS[name]["in"]:
        if not any(placed[p] for p in PRODUCERS_OF.get(r, ())):
            return False
    return True


def has_producer(placed, r):
    return any(placed[p] for p in PRODUCERS_OF.get(r, ()))


def power_state(placed):
    supply = 0.0
    wf = placed.get("windmill", [])
    if wf:
        kw = sum(1 + f for f in wf)             # cluster K once, not per windmill (O(n) not O(n^2))
        supply = sum(15 * (1 + f) * (1 + CLUSTER_RATE * (kw - (1 + f))) for f in wf)
    demand = 0.0
    heat_cap, heat_used = heat_capacity(placed), 0
    for name, floors in placed.items():
        if not floors:
            continue
        d = BUILDINGS[name]
        p = d["power"]
        if p >= 0:
            continue
        if d["in"] and not inputs_satisfied(name, placed):
            continue
        req_heat = d.get("requiresHeat")
        for f in floors:
            if req_heat:
                if heat_used >= heat_cap:
                    continue
                heat_used += 1
            demand += (-p) * (1 + 0.5 * f)
    return supply, demand


def flow_gates(prod, cons):
    """§15.3 net-flow gating (port of flow-solver.ts, zero-pinned side). Given each
    building's gate-1 production/consumption (throughput already baked in), return a
    gate g[b] ∈ [0,1] so that for EVERY resource, gated consumption ≤ gated
    production — i.e. a building starved of an input THROTTLES (runs slow) instead of
    driving that input negative. A consumer of an unproduced resource gets gate 0.
    Damped Gauss-Seidel over per-resource throttle factors (min rule per building)."""
    consumed = {r for c in cons.values() for r in c}
    if not consumed:
        return {b: 1.0 for b in prod}
    mul = {r: 1.0 for r in consumed}
    types = list(prod)
    for it in range(400):
        g = {}
        for b in types:
            gb = 1.0
            for r in cons[b]:
                m = mul[r]
                if m < gb:
                    gb = m
            g[b] = gb
        maxd = 0.0
        for r in consumed:
            P = C = 0.0
            mr = mul[r] if mul[r] > 1e-12 else 1.0
            for b in types:
                P += prod[b].get(r, 0.0) * g[b]
                cr = cons[b].get(r, 0.0)
                if cr:
                    C += cr * g[b] / mr        # consumption at the OTHER-gate (exclude r's own factor)
            nm = 1.0 if C <= P + 1e-12 else P / C
            if it > 60:
                nm = 0.5 * (nm + mul[r])       # damp oscillators
            maxd = max(maxd, abs(nm - mul[r]))
            mul[r] = nm
        if maxd < 1e-9:
            break
    return {b: min([mul[r] for r in cons[b]] + [1.0]) for b in types}


def net_rates(placed, production_only=False, force_full_power=False):
    """Per-resource net units/sec under power brownout + cluster + floor + heat +
    §15.3 FLOW gating. Starved consumers throttle (never negative) rather than
    requiring producers to scale without bound. production_only=True returns GROSS
    production at gate 1 (the §4.9 throttle: accumulate a pinned resource by idling
    its consumers). force_full_power pins pf=1."""
    supply, demand = power_state(placed)
    pf = 1.0 if force_full_power else (min(1.0, supply / demand) if demand > 1e-12 else 1.0)
    Kc = cluster_K(placed)
    heat_cap, heat_served = heat_capacity(placed), 0
    scrub_cap, scrub_served = scrub_capacity(placed), 0
    prod, cons = {}, {}
    for name, floors in placed.items():
        if not floors:
            continue
        d = BUILDINGS[name]
        cyc = d["cycle_s"]
        if cyc is None:
            continue
        powered = d["power"] < 0
        req_heat = d.get("requiresHeat")
        scrub_mul = d.get("scrub_mul")
        kcat = Kc[d["category"]] if _CLUSTERED[name] else None
        T = 0.0
        for f in floors:
            if req_heat:
                if heat_served >= heat_cap:
                    continue
                heat_served += 1
            mul = (1 + f) * (1 + CLUSTER_RATE * (kcat - (1 + f))) if kcat is not None else (1 + f)
            if scrub_mul:
                if scrub_served < scrub_cap:
                    scrub_served += 1
                else:
                    mul *= scrub_mul
            if powered:
                mul *= pf
            T += mul / cyc
        if T <= 0:
            continue
        prod[name] = {r: u * T for r, u in d["out"].items()}
        cons[name] = {r: u * T for r, u in d["in"].items()}
    g = {b: 1.0 for b in prod} if production_only else flow_gates(prod, cons)
    net = {}
    for b in prod:
        gb = g[b]
        for r, v in prod[b].items():
            net[r] = net.get(r, 0.0) + v * gb
        if not production_only:
            for r, v in cons[b].items():
                net[r] = net.get(r, 0.0) - v * gb
    if heat_served and not production_only:
        cpc = BUILDINGS["coal_furnace"]["coal_per_cycle"]
        net["coal"] = net.get("coal", 0.0) - heat_served * cpc / HEAT_CYCLE_S
    return net, pf


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


def windmill_power(floors):
    return sum(15 * (1 + f) * cluster_bonus(floors, i) for i, f in enumerate(floors))


def cost_of(a):
    """Placement / upgrade / crate cost of one action tuple."""
    kind, name, *rest = a
    if kind == "place":
        return BUILDINGS[name]["cost"]
    if kind == "crate":
        return BUILDINGS["crate"]["cost"]
    if kind == "crate_up":
        return upgrade_cost("crate", rest[0])
    return upgrade_cost(name, rest[0])         # building upgrade -> rest[0] = displayed floor


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
# Every building-state change — in simulation AND in commit — goes through here,
# so a plan proven safe on a simulated copy lands on the identical real state.
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
    else:  # upgrade lowest-floor instance of this type
        idx = min(range(len(placed[name])), key=lambda i: placed[name][i])
        placed[name][idx] += 1


class State:
    """Mutable run state. `placed`: name -> list of floorLevels. `crate_for`:
    resource -> list of crate floorLevels. `inv`: resource -> stock. `t`: seconds."""
    def __init__(self):
        self.placed = {name: [] for name in BUILDINGS}
        self.crate_for = {}
        self.inv = dict(STARTING_INVENTORY)
        self.t = 0.0

    def copy_placed(self):
        return {k: list(v) for k, v in self.placed.items()}


# ====================================================================
# PLAN — pure simulation. Returns the exact ordered action list that, applied via
# `mutate` on top of `want`, leaves every rate > EPS. Or None if unbalanceable.
# ====================================================================
FLOOR_SOFT_CAP = 9    # floorLevel; upgrade up to displayed floor 10, then add count
TILE_FLOOR_CAP = 40   # a cap-1 extractor can't realistically go past ~this floor —
                      # 1.15^(40-10) ≈ 66x base cost; beyond it the floor is just
                      # not worth building. Past this, balanced_scale gives up (the
                      # demanding chain must shrink, not drive quarry to fl100).


def balanced_scale(sim, typ):
    """One step that raises building `typ`'s output, balancing UPGRADE vs PLACE:
      * upgrade the lowest-floor instance while it's shallow (<= soft cap) — floor
        scaling ×(1+L) + cluster bonus, the efficient lever a real player uses;
      * place a new one once all instances are deep AND terrain cap allows — keeps
        per-action cost bounded (it explodes as 1.15^(floor-10) past floor 10);
      * if at terrain cap (tile-locked), keep upgrading deep — but only up to
        TILE_FLOOR_CAP, then give up (None) so an over-large chain can't push a
        cap-1 extractor to an absurd exponential floor.
    """
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


SCALE_JUMP_CAP = 3000      # max level-units one scale jump adds (to reach a solved size)
_SOLVED = {}               # building -> target level-units (cluster-aware recipe solve)


def solve_factory():
    """CLUSTER-BONUS-AWARE recipe-flow sizing. Returns L[b] = target level-units so
    every recipe-consumed resource balances WITH the §4.5 cluster bonus on both
    sides. The cure for the smelting feedback: the bonus amplifies a cluster's own
    demand (steel_mill_scrap's scrap, blast_furnace's iron_ore) ×bonus — a moving
    target greedy single-stepping can't catch, but solved to a fixed point here.
    Recipe flow only; one-time placement costs are left to the executor's payback
    gate. Each iteration adds one level-unit to the surplus-fed producer of the
    most-deficient resource."""
    L = {b: float(TARGET.get(b, 0)) for b in BUILDINGS}
    # Amortize big ONE-TIME placement costs into steady demand — but ONLY for
    # GRASS-produced resources (steel_beam, gear, concrete, glass, copper, pipe,
    # brick). This sizes the steel_beam -> steel -> steel_mill_scrap -> scrap ->
    # scrappers chain for blast_furnace/steel_mill's huge steel_beam placement, so
    # the executor isn't forever chasing scrap. Tile-locked resources (stone/clay/
    # wood/ores) are EXCLUDED — amortizing those forced exponential extractor floors
    # (quarry fl97); they accumulate slowly via the executor's payback gate instead.
    place_rate = {}
    for b, cnt in TARGET.items():
        for r, n in BUILDINGS[b]["cost"].items():
            if r not in TILE_LOCKED_RES:
                place_rate[r] = place_rate.get(r, 0.0) + n * cnt / BUILD_TIME_S

    def pick(r, net):
        prods = PRODUCERS_OF[r]
        if len(prods) == 1:
            return prods[0]

        def sc(typ):
            d = BUILDINGS[typ]
            neg = tl = 0.0
            for x, u in d["in"].items():
                draw = u / d["cycle_s"]
                if x in TILE_LOCKED_RES:
                    tl += draw
                after = net.get(x, 0.0) - draw
                if x != r and after < 0.0:
                    neg += (-after) * (1000.0 if x in TILE_LOCKED_RES else 1.0)
            return (neg, tl, len(d["in"]))
        return min(prods, key=sc)

    for _ in range(500000):
        K = {}
        for b, c in L.items():
            if c > 0 and _CLUSTERED[b]:
                K[_CATEGORY[b]] = K.get(_CATEGORY[b], 0.0) + c
        net = {}
        for b, c in L.items():
            d = BUILDINGS[b]
            cyc = d["cycle_s"]
            if c <= 0 or cyc is None:
                continue
            bonus = 1 + CLUSTER_RATE * (K[_CATEGORY[b]] - 1) if _CLUSTERED[b] else 1.0
            for r, u in d["out"].items():
                net[r] = net.get(r, 0.0) + c * u / cyc * bonus
            for r, u in d["in"].items():
                net[r] = net.get(r, 0.0) - c * u / cyc * bonus
        worst_r, worst = None, -1e-9
        for r in set(net) | set(place_rate):
            if r not in PRODUCERS_OF:
                continue
            v = net.get(r, 0.0) - place_rate.get(r, 0.0)
            if v < worst:
                worst, worst_r = v, r
        if worst_r is None or sum(L.values()) > 100000:
            break
        L[pick(worst_r, net)] += 1.0
    return L


def best_producer(sim, r):
    """Producer of `r` to scale. With several (e.g. ~25 scrappers all make scrap),
    pick the one that drives the LEAST production non-positive once added — scarce
    tile-locked resources (stone/clay/wood/ores: cap-limited, exponential to fix)
    weighted ~1000x above grass goods, then least scarce draw, then fewest inputs.
    Scrap faucets are category 'special' (NOT clustered) so adding one just
    subtracts its input draws from `net` — no per-candidate net_rates needed."""
    prods = [n for n in BUILDINGS
             if BUILDINGS[n]["out"].get(r, 0) > 0 and inputs_satisfied(n, sim)]
    if not prods:
        return None
    if len(prods) == 1:
        return prods[0]
    net = net_rates(sim)[0]

    def score(typ):
        d = BUILDINGS[typ]
        cyc = d["cycle_s"]
        neg = tl_draw = 0.0
        for x, u in d["in"].items():
            draw = u / cyc
            if x in TILE_LOCKED_RES:
                tl_draw += draw
            after = net.get(x, 0.0) - draw
            if x != r and after < EPS:
                neg += (EPS - after) * (1000.0 if x in TILE_LOCKED_RES else 1.0)
        return (neg, tl_draw, len(d["in"]))

    return min(prods, key=score)


def scale_action(sim, r):
    """A PROPORTIONAL batch of scaling steps on `r`'s best producer — sized to clear
    `r`'s current deficit in one shot (~ceil(deficit / per-step gain)) rather than a
    single floor. This is what lets a cluster-amplified demand (a smelting consumer
    fed by a non-clustered cap-1 extractor) converge in a few plan iterations instead
    of thousands. Returns the action list (>=1), or None if `r` has no producer."""
    typ = best_producer(sim, r)
    if typ is None:
        return None
    # Jump `typ` straight to its SOLVED level-units (sized for the final cluster
    # bonus), not one floor at a time — so a cluster-amplified demand is met at once
    # instead of chased. If already at/over the solved size but `r` is still short
    # (solve slack), nudge one step.
    # RAMPED jump: enough to clear the CURRENT deficit (so early/low demand stays
    # small — no over-scaling), but CAPPED at the solved level-units for `typ` (so
    # a cluster-amplified chain like scrap can't run away — it stops at the
    # fixed-point size). Clears in a few iterations without chasing a moving target.
    cur = net_rates(sim)[0].get(r, 0.0)
    s = {k: list(v) for k, v in sim.items()}
    a1 = balanced_scale(s, typ)
    if a1 is None:                          # producer hit its floor cap (tile-locked)
        return None
    mutate(s, {}, a1)
    dR = net_rates(s)[0].get(r, 0.0) - cur
    n_clear = ceil((EPS - cur) / dR) if dR > 1e-12 else 1
    n_solved = ceil(_SOLVED.get(typ, 0.0) - sum(1 + f for f in sim[typ]))
    n = max(1, min(int(n_clear), max(1, int(n_solved)), SCALE_JUMP_CAP))
    acts = [a1]
    for _ in range(n - 1):
        a = balanced_scale(s, typ)
        if a is None:
            break
        acts.append(a)
        mutate(s, {}, a)
    return acts


def payback_scale(sim, cf, cost, inv):
    """EXECUTOR TIME-PAYBACK GATE. `cost` is the placement cost of the building we
    are about to acquire. Find its slowest-to-accumulate resource (max remaining /
    rate) and return a scale of that resource's producer IFF upgrading first is
    faster overall:  t_pay + remaining/(rate+dR)  <  remaining/rate  (pay the
    upgrade now, then accumulate at the higher rate). Returns None when nothing pays
    off — we accept the slower accumulation instead. THIS is what stops a tile-locked
    quarry being driven to floor 97: once a floor's (exponential) cost outweighs the
    speed-up it buys, the gate rejects it."""
    net = net_rates(sim)[0]
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
    typ = best_producer(sim, r)
    if typ is None:
        return None
    a = balanced_scale(sim, typ)            # ONE step — the gate is evaluated per step
    if a is None:                           # producer floor-capped — accept slow accrual
        return None
    s2 = {k: list(v) for k, v in sim.items()}
    mutate(s2, {k: list(v) for k, v in cf.items()}, a)
    dR = net_rates(s2)[0].get(r, 0.0) - rate
    if dR <= 1e-12:
        return None
    remaining = cost[r] - inv.get(r, 0.0)
    gross = net_rates(sim, production_only=True)[0]
    t_pay = time_to_afford(inv, cost_of(a), net, cf, gross)
    if t_pay == float("inf"):
        return None
    t_now = remaining / rate if rate > 1e-12 else float("inf")
    t_up = t_pay + remaining / (rate + dR)
    return a if t_up < t_now else None


def plan_for(state, want):
    """Place one building `want` and add every prerequisite until all rates > EPS,
    returning the exact ordered batch (mutate-order, so commit reproduces it) or
    None. Order of fixes: (1) TOPOLOGY — a producer for any recipe input lacking one
    (e.g. a scrapper for scrap); (2) HEAT — coal furnaces; (3) SCRUBBER; (4) recipe
    NEGATIVES — a windmill if the deficit is brownout-induced, else scale the
    starved producer (MANDATORY, no gate); (5) once positive, PLACEMENT-COST PAYBACK
    — scale a producer of `want`'s slowest cost resource only while it pays off."""
    sim = state.copy_placed()
    cf = {k: list(v) for k, v in state.crate_for.items()}
    plan = [want]
    mutate(sim, cf, want)
    for _ in range(PLAN_STEP_CAP):
        gated = [r for r in BUILDINGS[want[1]]["in"] if not has_producer(sim, r)]
        if gated:
            acts = scale_action(sim, gated[0])
            if acts is None:
                _FAIL[0] = f"no producer for input {gated[0]}"
                return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        if needs_furnace(sim):
            a = ("place", "coal_furnace")
            plan.append(a); mutate(sim, cf, a); continue
        if needs_scrubber(sim):
            a = ("place", "exhaust_scrubber")
            plan.append(a); mutate(sim, cf, a); continue
        net = net_rates(sim)[0]
        negs = sorted(r for r, v in net.items() if v < EPS)
        if negs:
            r = negs[0]
            brownout = power_state(sim)[1] > power_state(sim)[0] + 1e-9
            full = net_rates(sim, force_full_power=True)[0] if brownout else net
            if brownout and full.get(r, 0.0) >= EPS:
                acts = [balanced_scale(sim, "windmill")]
            else:
                acts = scale_action(sim, r)
                if acts is None:
                    _FAIL[0] = f"can't scale starved {r}"
                    return None
            for a in acts:
                plan.append(a); mutate(sim, cf, a)
            continue
        a = payback_scale(sim, cf, cost_of(want), state.inv)
        if a is not None:
            plan.append(a); mutate(sim, cf, a); continue
        return plan
    _FAIL[0] = (f"step cap {PLAN_STEP_CAP} hit; still negative: "
                f"{sorted(x for x, v in net_rates(sim)[0].items() if v < EPS)[:6]}")
    return None


# ====================================================================
# COMMIT — afford the plan (provisioning storage crates), advance time, apply the
# SAME list via the SAME `mutate`. Returns True, or False if unaffordable.
# ====================================================================
def advance(state, cost):
    """Advance time until `cost` is affordable, integrating inventory at current
    rates (deadlocked resources accrue at the §4.9 gross rate), then deduct it.
    Returns False (no mutation, no time spent) if it can never be afforded."""
    net = net_rates(state.placed)[0]
    gross = net_rates(state.placed, production_only=True)[0]
    dt = time_to_afford(state.inv, cost, net, state.crate_for, gross)
    if dt == float("inf"):
        return False
    for r in set(net) | set(cost):
        rate = net.get(r, 0.0)
        if rate <= 1e-12 and (cost.get(r, 0) - state.inv.get(r, 0)) > 0:
            rate = gross.get(r, 0.0)
        before = state.inv.get(r, 0)
        after = before + rate * dt
        if rate > 0:                           # §4.6 force-on: can't refill past cap
            after = min(after, max(nominal_cap(r, state.crate_for), before))
        state.inv[r] = after
    state.t += dt
    for r, n in cost.items():
        state.inv[r] = state.inv.get(r, 0) - n
    return True


def crate_action_for(crate_for, r):
    """Raise storage for `r`: upgrade its lowest crate below floor 11, else a new one."""
    upgradable = [L for L in crate_for.get(r, []) if L < 10]
    if upgradable:
        return ("crate_up", r, min(upgradable) + 2)
    return ("crate", r)


def commit(state, plan):
    """Provision crates for the plan's combined cost, advance, then apply the plan
    via `mutate`. Returns True on success. On any unaffordable step returns False
    WITHOUT having applied the plan (crates already added are harmless surplus)."""
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
# MAIN LOOP — pick a ready, still-needed TARGET building; plan it; commit it.
# ====================================================================
def can_produce(placed, r):
    """r already has a placed producer, OR a producer that COULD be placed now
    (its own recipe inputs are satisfied) — e.g. a scrapper for `scrap`, whose
    basket inputs are all produced. Lets a consumer of `scrap` become `ready`
    even though scrappers aren't TARGET buildings; plan_for then places one."""
    return any(BUILDINGS[p]["out"].get(r, 0) > 0 and (placed[p] or inputs_satisfied(p, placed))
               for p in BUILDINGS)


def ready(placed, name):
    """A building may be placed once every recipe input is producible (so it
    actually runs rather than sitting idle)."""
    return all(can_produce(placed, r) for r in BUILDINGS[name]["in"])


def needed_counts(state):
    return {n: TARGET[n] - len(state.placed[n]) for n in TARGET
            if len(state.placed[n]) < TARGET[n]}


def assert_positive(state, label):
    """Invariant guard: every rate strictly positive. Raises if violated — turns a
    silent negative into a loud, located failure instead of a wrong plan."""
    net = net_rates(state.placed)[0]
    bad = {r: round(v * 3600, 4) for r, v in net.items() if v < -1e-6}  # gating pins at 0; flag only true negatives
    if bad:
        raise AssertionError(f"NEGATIVE/ZERO rate after {label} @ {fmt_dur(state.t)}: {bad}")


def show_breakdown(state):
    print("    Final buildings (count, by displayed floor):")
    for n, fl in state.placed.items():
        if not fl:
            continue
        extra = f"   [{windmill_power(fl):.0f} kW]" if n == "windmill" else ""
        print(f"      {n:<24} x{len(fl):<4} {floor_breakdown(fl)}{extra}")
    if state.crate_for:
        tot = sum(len(v) for v in state.crate_for.values())
        print(f"      {'crate':<24} x{tot:<4} "
              + "; ".join(f"{r}:[{floor_breakdown(fl)}]"
                          for r, fl in sorted(state.crate_for.items())))
    net = net_rates(state.placed)[0]
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
    print("ROBOT ISLANDS — bootstrap build planner v2 (positive-invariant)")
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
    print(f"Power demand of target consumers (base floor): {demand} kW")
    _SOLVED.update(solve_factory())
    print(f"Cluster-aware solve: {sum(round(v) for v in _SOLVED.values()):.0f} "
          f"recipe level-units across {sum(1 for v in _SOLVED.values() if v > 0)} types.\n")

    # Place each TARGET building once, in dependency order (bootstrap producers
    # first). plan_for sizes the producers around it — recipe scaling to keep rates
    # positive (mandatory) and payback-gated scaling to make expensive placement
    # costs affordable without grinding deep tile-locked floors.
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
                        return 0          # bootstrap producer first
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
                gross = net_rates(state.placed, production_only=True)[0]
                nt = net_rates(state.placed)[0]
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
