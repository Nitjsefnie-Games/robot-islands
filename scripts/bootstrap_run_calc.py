#!/usr/bin/env python3
"""Robot Islands — bootstrap-run placement-cost & refund calculator.

Level-1 buildings only. Models ONLY placement cost for the affordability
accounting (footprint / tile gating deliberately ignored per the brief).
Power and recipe rates are kept because two pipeline steps need them:
  - "enough windmills to power the run"  -> needs power consumes/produces
  - "how fast it would refund"           -> needs recipe production rates

All constants verified against the repo at commit 44dfcb4 (2026-06-16):
  - starting inventory : src/world.ts  startingInventory()
  - placement cost     : src/building-defs.ts
  - power              : src/building-defs.ts  (def.power.{consumes,produces})
  - recipe rates       : src/recipes.ts        (cycleSec, inputs, outputs)

Pipeline (as requested):
  starting inventory -> logger -> quarry -> coal mine + iron mine
  -> enough windmills to power the run -> smelter -> refund time
"""

from math import ceil

# ---------------------------------------------------------------------------
# Step 1 — starting inventory  (src/world.ts startingInventory())
# ---------------------------------------------------------------------------
STARTING_INVENTORY = {
    "stone": 1200,
    "wood": 600,
    "iron_ore": 30,
    "coal": 80,
    "iron_ingot": 60,
    "bolt": 25,
    "limestone": 15,
    "saltwater_cell": 4,
    "foundation_kit": 1,
    "scrap": 5000,
}

# ---------------------------------------------------------------------------
# Building catalog (level 1 only).
#   cost     : placementCost basket (src/building-defs.ts)
#   power_kw : +produces / -consumes, kW (src/building-defs.ts def.power)
#   cycle_s  : recipe cycleSec (src/recipes.ts); None = no recipe
#   outputs  : units produced per cycle
#   inputs   : units consumed per cycle
# A "coal mine" and an "iron mine" are the SAME `mine` def placed on different
# ore tiles (mine_on_coal / mine_on_ore): identical cost/power/cycle, only the
# output resource differs.
# ---------------------------------------------------------------------------
BUILDINGS = {
    "logger": {
        "cost": {"stone": 30, "wood": 30, "iron_ingot": 10},
        "power_kw": 0,                       # logger def has no power field
        "cycle_s": 1404.1, "inputs": {}, "outputs": {"wood": 1},
    },
    "quarry": {
        "cost": {"stone": 120, "wood": 80, "iron_ingot": 30},
        "power_kw": -25,
        "cycle_s": 40, "inputs": {}, "outputs": {"stone": 1},
    },
    "iron_mine": {  # mine on ore vein -> mine_on_ore
        "cost": {"stone": 200, "wood": 80},
        "power_kw": -25,
        "cycle_s": 20, "inputs": {}, "outputs": {"iron_ore": 1},
    },
    "coal_mine": {  # mine on coal vein -> mine_on_coal
        "cost": {"stone": 200, "wood": 80},
        "power_kw": -25,
        "cycle_s": 20, "inputs": {}, "outputs": {"coal": 1},
    },
    "clay_pit_extractor": {
        "cost": {"stone": 140, "wood": 80},
        "power_kw": -25,
        "cycle_s": 40, "inputs": {}, "outputs": {"clay": 1},
    },
    "windmill_t0": {
        "cost": {"wood": 80, "stone": 20, "iron_ingot": 3},
        "power_kw": +15,
        "cycle_s": None, "inputs": {}, "outputs": {},
    },
    "smelter": {
        "cost": {"stone": 400, "clay": 100, "wood": 20},
        "power_kw": -50,
        "cycle_s": 2981.3,
        "inputs": {"iron_ore": 10, "coal": 3},
        "outputs": {"iron_ingot": 6, "slag": 2, "co": 5},
    },
}


def rates_per_sec(defn):
    """Steady-state per-second input/output flows for one building at 100% uptime."""
    c = defn["cycle_s"]
    if not c:
        return {}, {}
    ins = {r: n / c for r, n in defn["inputs"].items()}
    outs = {r: n / c for r, n in defn["outputs"].items()}
    return ins, outs


def fmt_dur(seconds):
    if seconds == float("inf"):
        return "never"
    h = seconds / 3600
    if h < 48:
        return f"{h:.1f} h"
    return f"{h / 24:.1f} days"


def main():
    print("=" * 64)
    print("ROBOT ISLANDS — bootstrap run (level-1 buildings, placement cost)")
    print("=" * 64)

    # --- Step 1: starting inventory ---
    print("\n[1] Starting inventory:")
    for r, n in STARTING_INVENTORY.items():
        print(f"      {r:<16} {n}")

    # --- Build order ---
    # logger, quarry, iron mine, coal mine, <windmills>, smelter
    # Windmill count is computed from total power demand, then spliced in.
    consumers = ["logger", "quarry", "iron_mine", "coal_mine",
                 "clay_pit_extractor", "smelter"]
    total_demand = -sum(BUILDINGS[b]["power_kw"] for b in consumers
                        if BUILDINGS[b]["power_kw"] < 0)
    per_windmill = BUILDINGS["windmill_t0"]["power_kw"]
    n_windmills = ceil(total_demand / per_windmill)

    print(f"\n[5] Power: consumers draw {total_demand} kW; "
          f"windmill_t0 gives {per_windmill} kW each "
          f"-> {n_windmills} windmills ({n_windmills * per_windmill} kW).")

    build_order = [
        ("logger", 1),
        ("quarry", 1),
        ("iron_mine", 1),
        ("coal_mine", 1),
        ("clay_pit_extractor", 1),
        ("windmill_t0", n_windmills),
        ("smelter", 1),
    ]

    # --- Steps 2-6: place buildings, track running inventory + total cost ---
    inv = dict(STARTING_INVENTORY)
    total_cost = {}
    print("\n[2-6] Placing buildings (debiting placement cost):")
    for name, qty in build_order:
        cost = BUILDINGS[name]["cost"]
        for r, n in cost.items():
            inv[r] = inv.get(r, 0) - n * qty
            total_cost[r] = total_cost.get(r, 0) + n * qty
        basket = " + ".join(f"{n*qty} {r}" for r, n in cost.items())
        print(f"      {name:<14} x{qty:<3} -> {basket}")

    print("\n      Total placement cost:")
    for r, n in sorted(total_cost.items()):
        print(f"        {r:<16} {n}")

    # --- Affordability: where does the running inventory go negative? ---
    print("\n      Affordability vs starting inventory:")
    shortfalls = {r: -v for r, v in inv.items() if v < 0}
    for r in sorted(total_cost):
        have = STARTING_INVENTORY.get(r, 0)
        left = inv[r]
        flag = "  <-- SHORT" if left < 0 else ""
        print(f"        {r:<16} have {have:>5}  spend {total_cost[r]:>5}  "
              f"left {left:>6}{flag}")
    if shortfalls:
        print("\n      >>> NOT affordable from the starter kit. Short:")
        for r, n in sorted(shortfalls.items()):
            print(f"          {n} {r}")
    else:
        print("\n      >>> Affordable from the starter kit.")

    # --- Step 7: refund time ---
    # ASSUMPTION (confirm): "refund" = payback period — time for the chain's
    # net production to regenerate the placement-cost basket that was spent,
    # at 100% uptime, level-1 rates. Per-resource; the run is "refunded" when
    # the slowest spent resource is recovered.
    print("\n[7] Refund / payback (regenerate the spent basket at 100% uptime):")
    net = {}
    for name, qty in build_order:
        ins, outs = rates_per_sec(BUILDINGS[name])
        for r, rate in outs.items():
            net[r] = net.get(r, 0) + rate * qty
        for r, rate in ins.items():
            net[r] = net.get(r, 0) - rate * qty

    worst = 0.0
    for r in sorted(total_cost):
        spent = total_cost[r]
        prod = net.get(r, 0)
        t = spent / prod if prod > 1e-12 else float("inf")
        worst = max(worst, t) if t != float("inf") else float("inf")
        producer = f"{prod*3600:.2f}/h" if prod > 1e-12 else "no producer"
        print(f"        {r:<16} spend {spent:>5}  net {producer:>14}  "
              f"-> {fmt_dur(t)}")
    print(f"\n      >>> Full-basket payback (slowest resource): {fmt_dur(worst)}")


if __name__ == "__main__":
    main()
