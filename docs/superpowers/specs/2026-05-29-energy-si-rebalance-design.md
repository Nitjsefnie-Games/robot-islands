# Energy SI rebalance — design spec

**Date:** 2026-05-29. **Status:** design locked, pending user approval → writing-plans.
**Companion data:** `2026-05-29-energy-si-consumer-table.md` (full 211-row consumer table).

## Problem

The SI rework defined "1 unit power = 100 kW" (§2.1) but **never applied it**. Three
inconsistencies coexist:

- `power.produces/consumes` are raw abstract numbers; the **HUD labels them `"W"`**
  (`hud.ts:577`) — a water wheel reads "20W" when it should be a real rating.
- The **battery energy table** (`economy.ts:79 BATTERY_CAPACITY_WS`) is built as
  watt-seconds treating the unit as **W** (`battery_bank: 5_000*3600` = 5 kWh) — so the
  battery half is sized in real kW/kWh while producers look ~1000× too small.
- The **big generators** are off-scale relative to the (already-realistic) renewables
  and consumers.

## The reframe (key finding from consumer research)

Interpreted as **kW**, the ~211 consumers and the small renewables are **already
realistic** (Mine 25, Smelter 50–80, refinery 100–250 kW; water_wheel 20, windmill 15).
The broken half is: (1) the **unit label**, (2) the **big dispatchable generators**,
(3) **two electric-process consumers**, (4) the **battery table + HUD**.

## Locked decisions

1. **Canonical unit = kW.** Consistent with heat (`thermalKW`) and battery (kWh):
   kW × h = kWh. Display auto-formats W / kW / MW / GW via a `fmtPower(kW)` helper.
2. **Accept the realistic generation cliff.** True-SI generators (coal_gen 5 MW …).
   One coal plant powers ~200 Mines; power is scarce in the early renewable phase and
   the heavy-industry endgame, cheap in between — re-tune scarcity via build cost /
   coal supply / recipe rates, **not** by shrinking generators.
3. **Drop `requiresHeat` on the Electric Arc Furnace.** An EAF is its own electric
   heat → pure-electric 10 MW draw (keeping `requiresHeat` would zero its output with
   no adjacent heat source).
4. **`consumes` is electrical only.** Heat-fed furnaces (coke_oven, blast_furnace,
   pyroforge) keep small auxiliary electrical loads; smelting energy flows through the
   `thermalKW` adjacency system (no double-count).

## §1 Producer scale (web-grounded)

| Building | Tier | now | → kW | real-world anchor |
|---|---|---|---|---|
| newcomen_engine | T1 | 4 | 4 kW | Newcomen ~5 hp ≈ 3.7 kW |
| windmill_t0 | T0 | 15 | 15 kW | small wind 2–10 kW |
| water_wheel | T0 | 20 | 20 kW | overshot 2–20 kW (≤200 industrial) |
| wind_turbine | T1 | 40 | 100 kW | small-commercial wind ≤100 kW |
| solar | T1 | 50 | 50 kW | ~150–250 W/m² × array |
| biomass_plant | T1 | 80 | 1 MW | small biomass 0.5–2 MW |
| geothermal_vent | T1 | 200 | 1 MW | modular geothermal 0.3–20 MW |
| coal_gen | T1 | 50 | 5 MW | small-modular coal 50–350 MW (bottom); 1 coal/2s × 25 MJ/kg × 40% = 5 MW |
| cryogenic_generator | T2 | 400 | 3 MW | liquid-air storage discharge ~MW |
| geothermal_vent_generator | T6 | 2000 | 20 MW | large geothermal |
| tidal_array | T4 | 50000 | 50 MW | MeyGen array 6→398 MW (**already correct**) |
| sunspire | T4 | 60000 | 60 MW | CSP tower 50–150 MW (**already correct**) |
| nuclear_reactor | T3 | 2000 | 200 MW | SMR 50–300 MW |
| fusion_core | T4 | 5000 | 300 MW | ARC/DEMO 200–500 MWe |
| casimir_tap | T5 | 8000 | 1 GW | exotic endgame |

## §2 Consumer changes

Most of the 211 consumers are **unchanged** (their current value is the realistic kW).
Material changes only:

| Building | now | → | reason |
|---|---|---|---|
| electric_arc_furnace | 200 | **10 MW** + drop `requiresHeat` | electricity IS the heat (real EAF 60–120 MW connected; small end) |
| aluminum_smelter | 500 | **10 MW** | Hall-Héroult electrolysis ~13 kWh/kg |
| minor tier nudges | — | ±10–30 kW | tier coherence (e.g. hard-rock mines 40→35, T1 high-MP smelters 50→80) |

Full per-building values: `2026-05-29-energy-si-consumer-table.md`.

## §3 Battery + energy integration

The unit relabel W→kW **auto-scales battery capacities ×1000** with no integration-math
change (the `BATTERY_CAPACITY_WS` numbers are unchanged; they now read as kW·s):

| Battery | was (label) | becomes | fit |
|---|---|---|---|
| battery_bank | 5 kWh | **5 MWh** | 5 MW coal_gen fills in 1 h ✓ |
| capacitor_bank | 100 kWh | **100 MWh** | — |
| flywheel_array | 2 MWh | **2 GWh** | — |
| singularity_battery | 50 MWh | **50 GWh** | — |

This is desirable (a kWh buffer would fill in seconds at MW generation). Actions:
rename `BATTERY_CAPACITY_WS → BATTERY_CAPACITY_KWS` (or keep name, doc the unit), update
the capacity comments/labels in `building-defs.ts` and any HUD readout.

## §4 Unchanged logic

- **Brownout** `factor = min(1, producedTotal/consumedTotal)` — unit-agnostic ratio,
  no change (now operates on kW).
- **Cable network W-capacity** (`routes.ts`) — rides the same unit; relabel only.
- **Daynight solar curve** — multiplies the solar base (now 50 kW); no change.

## §5 Progression impact — power tension by stage

Build-cost gates (not just kW) shape the curve. Early generators buildable from basic
materials are only **water_wheel** (20 kW, water tile; home fits ~4 → 80 kW) and
**windmill_t0** (15 kW, grass, wood-limited). **solar** is T3-gated (needs silicon/wire/
aluminum); **geothermal_vent** (1 MW) is **volcanic-biome only**; **coal_gen / biomass /
wind_turbine** all need **steel_beam** (coal_gen also microchip) → unavailable until the
steel chain — which itself needs power. The result is a **sawtooth**:

| Stage | Tier / level | Generation available | Key loads | Tension |
|---|---|---|---|---|
| **Early bootstrap** | T0–T1, home, pre-steel | water_wheel 20 kW (×~4), windmill 15 kW | extractors 25, smelter 50, workshop 60 kW | **SCARCE** — sources (≤~100 kW) can't cover the iron→steel bootstrap; brownout-throttled. Longest/tightest phase. Escapes: settle a **volcanic** island (geothermal 1 MW) or grind steel under brownout. This is the deferred reachability gate. |
| **First generator** | T1–T2, post-steel | coal_gen **5 MW** / biomass 1 MW / geothermal 1 MW | full T2 island ~1–3 MW | **CLIFF → ABUNDANT** — one coal_gen runs ~200 extractors. Power flips from brutal to trivial in a single build. |
| **Heavy industry** | T3, L15 | scale coal_gens; nuclear **200 MW** | EAF **10 MW**, aluminum **10 MW** | **RE-TIGHTEN** — a single 10 MW process exceeds one coal_gen (5 MW); forces 2–3 coal_gens or reaching nuclear. |
| **Late** | T4, L30 | nuclear 200, fusion **300 MW**, tidal 50, sunspire 60 MW | labs/fabs 0.5–1.5 MW | **ABUNDANT** — one nuclear/fusion runs an island; T5 raws (aetheric_conduit 60, eldritch_sieve 80, spacetime_resonator 100 MW) begin to bite. |
| **Endgame** | T5–T6, L50+ | casimir_tap **1 GW** | megastructures 60–100 MW | **RE-TIGHTEN at GW scale** — exotic raws need a fusion array / casimir. Ratios stay sane (100 MW load vs 1 GW). |

**Feel change vs the old scale.** Old values sat within ~10–100× across the board
(compressed) → power was a *continuous* "always need a few more generators" constraint.
The SI scale makes it *punctuated*: a long scarce early game, then **cliffs of abundance**
interrupted by power-hungry-process spikes (EAF/aluminum at T3, megastructures at T5).
Brownout keeps the scarce phases graceful (throttle, not deadlock).

**Tuning levers** (balance is tuned via rates/costs, not power values):
- *Early-phase length* = how hard the steel chain bootstraps under brownout. Smooth via
  starter power, a cheaper early generator, or making volcanic-settlement (geothermal) an
  intended early objective.
- *Cliff sharpness* = the gap between the best pre-steel source (~20–100 kW) and coal_gen
  (5 MW). If too abrupt, add an intermediate **steel-free ~500 kW** generator.
- *Mid/late re-tightens* are healthy demand spikes **iff** the next generator tier is
  reachable when the power-hungry consumer unlocks — verify gating alignment.

## §6 Balance consequences (re-tune via rates/costs, not power values)

- **Generation cliff** (accepted): mid-game power is cheap once coal_gen unlocked.
- **Coal EROI now ~360×** (mine 25 kW / 0.9 coal·s⁻¹ vs coal_gen 5 MW / 0.5 coal·s⁻¹).
  Real coal EROI ~30–80×. The draws are sound; the ratio comes from the `mine_on_coal`
  rate (9 coal/10s, an old-scale tuning). **Retune target ~30–80×** by lowering mine
  coal output or raising its rate — a recipe change, not a power change.
- **EAF / aluminum (10 MW)** need ~2× coal_gen or one nuclear/fusion — intentional.
- **Chlor-alkali / ASU / particle accelerator** kept at small-modular end
  (150 kW / 300 kW / 1.5 MW vs real 1–200 MW) for playability — tunable.

## §6 Open design items (decide during planning)

- **Genesis Chamber** draw should scale with the runtime-selected target tier
  (SPEC L1431: T1≈50 kW … T4≈50 MW); a static `consumes` can't capture it — compute
  from the selected target.
- **T3 consumer tier** could arguably be higher; current research puts most at
  100–600 kW — tunable if T3 should feel more power-hungry.

## §7 Verification

- New `fmtPower(kW)` unit test: 0.02→"20 W", 20→"20 kW", 5000→"5 MW", 1e6→"1 GW".
- HUD shows kW/MW/GW (not "W"); manual screenshot of the power row.
- Producer values match §1; EAF has no `requiresHeat` and 10 MW; battery caps ×1000.
- Brownout fixtures still pass (ratio unchanged); battery charge-time sanity test
  (5 MW into 5 MWh ≈ 1 h).
- `npm test` green; `npx tsc --noEmit` clean; `npm run build` ok.

## §8 Scope / files

- `src/building-defs.ts` — 15 producer values; EAF + aluminum_smelter; drop EAF
  `requiresHeat`; minor consumer nudges; battery capacity labels.
- `src/economy.ts` — `BATTERY_CAPACITY_WS` rename/doc (values unchanged).
- `src/hud.ts:577` — `fmtPower(kW)` formatter.
- `src/routes.ts` — cable-capacity unit label.
- Tests — power fixtures, fmtPower, brownout regression, battery sanity.
- `recipes.ts` — (follow-up) `mine_on_coal` rate retune for EROI target.
