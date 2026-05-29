# Tutorial consolidation — design spec (DRAFT for review)

**Date:** 2026-05-29. **Status:** chain drafted; awaiting user review of the full
step list before this spec is accepted → then writing-plans.
**Supersedes the paused findings:** `2026-05-29-tutorial-consolidation-findings.md`.

## Decision (locked)

Consolidate onto the **Phase-7 hint-overlay** framework (`TUTORIAL_STEPS` →
`currentStep`/`checkDismissals` → `refreshTutorialHint`). **Remove the legacy
objective banner** (`renderTutorialBanner` + `checkObjectives` + `_OBJECTIVES`)
from the ticker and from `tutorial.ts`, porting its `check()` predicates into
step triggers. One ordered chain, full depth T0→T5, every step trigger wired,
overlay moved to the **left** corner.

## Conventions for the chain

- Each step is a `TutorialStep`: `id`, `mechanic` (bold label), `hint` (concise,
  card-fit), `expectedAction` (the "Place X (cost) on tile" line), `priority`,
  `triggerCondition` (when it shows), `dismissalCondition` (when it auto-advances),
  and a new optional `targetDefId` / `targetRecipeId` used by the trigger AND a
  guard test (def exists + required tile matches).
- **Power is kW** (post energy-SI-rebalance). Power hints use real units.
- `[C]` = concept/info step (no build; dismiss on a related signal or short TTL).
- Tier gates: **T2 = island L5, T3 = L15, T4 = L30, T5 = L50 + aiCoreCrafted.**
- Costs/tiles/recipes below are verified against `building-defs.ts` / `recipes.ts`.
- ⚠ = correction from the stale legacy/Phase-7 text.
- Per-step **XP bump** retained (`xpBumpPercentForCompletion`) — KEEP per locked decision.

## Reachability prep (Phase 0 — must precede the chain rewrite)

The step-verifier + dependency analysis proved the chain is unbuildable end-to-end
without these game/terrain fixes. All locked. With them, the full milestone-target
prerequisite closure (**30 buildings**, computed via `rotateOutputs`/exogenous-aware
topo) is reachable with **no cycles**.

1. **Seed `scrap` in the rev-9 starter** (`world.ts startingInventory`) — breaks the
   `steel_beam` bootstrap circularity: seeded scrap → `steel_mill_scrap` → steel →
   `beam_mill` → steel_beam → the steel chain self-sustains on pig iron. Amount tunable
   (the *quantity* grind to 30 000-steel_beam BOMs is handled by the throughput+floors pass).
2. **Add a mass-balanced `calcium_sulfonate` producer recipe** (auditor-enforced) — e.g.
   `sulfur + quicklime + heavy_oil → calcium_sulfonate` at a chemistry building. Closes the
   only remaining no-producer gap (it feeds `lubricant_refinery` → maintenance). (`air`,
   `strange_matter`, `tachyon_stream` are non-gaps: exogenous atmosphere input / produced via
   `rotateOutputs`.)
3. **Home terrain (`island.ts` + `makeHomeIslandSpec`):**
   - `majorRadius`/`minorRadius` **14 → 16** so the ~30 buildings + nodes fit. Only home is
     hand-placed; neighbors are procedurally generated with overlap-detection against home, so
     a larger home simply places procedural neighbors further out — no collision risk. (Just
     confirm the procedural layout still seeds a sensible spread.)
   - Add a **second 2×2 `stone` cluster** (Quarry #5 + Quartz Mine both need a `stone` 2×2).
   - Add a **`sulfur_vein` cluster** (sulfur feeds `calcium_sulfonate` + `sulfuric_acid_plant`;
     home had no sulfur — only the slow diesel byproduct otherwise).
4. **Chain content corrections** (from the verifier): step-17 concrete recipe hint is
   "cement + sand + stone + water → concrete" (NOT stone+clay); reword the `tier:1`-but-
   narrated-as-T2/T3 buildings (concrete_plant, copper_mine/smelter, glassworks, biofuel_plant,
   electrolyzer) if tier framing matters.

## Full-supply-chain expansion (decision: every producer a step, in dependency order)

The current 53 milestone steps become a topologically-complete chain by **inserting the
missing prerequisite producers** the closure surfaced, in build order, before their
consumers: `beam_mill` + the scrap/steel bootstrap, `pipe_mill`, `ceramic_kiln`,
`lead_smelter`, `slag_reprocessor`, `mag_alloyer` → `mag_forge`, `wafer_lab`,
`silicon_crusher` (already present), `limekiln`→quicklime, `cement_mill`, `air_separator`→
oxygen *before* steel, the cryo chain. Closure backbone (30, build order):
`smelter → workshop → glassworks → shipyard → biofuel_plant → kit_assembler → lead_smelter →
copper_smelter → assembler → antenna_t1 → beam_mill → dronepad → lubricant_refinery →
ceramic_kiln → pipe_mill → slag_reprocessor → metal_rolling_mill → cell_press →
silicon_crusher → battery_bank → lithography_lab → mag_alloyer → wafer_lab → pyroforge →
mag_forge → quantum_chip_fab → quantum_manipulator → particle_accelerator →
cryogenic_compute_center → reality_forge`. The authored chain interleaves these with the
orientation/power/settlement/concept steps, then is re-run through the step-verifier.

---

## THE CHAIN (T1 → T5)

### T1 — Orientation, power, and the iron chain (Level 1)

| # | id | mechanic | hint | place (building · cost · tile) | advances when |
|---|---|---|---|---|---|
| 1 | `01_location` | Location | Click where you live — real sunrise & sunset follow real time at that spot. | — (map picker) | `playerLat/Lon` set |
| 2 | `02_inventory` `[C]` | Your stockpile | You start with 1200 stone, 600 wood, 30 iron ore, 80 coal, 60 iron ingots, 25 bolts, 15 limestone, 4 saltwater cells, 1 foundation kit. | — | dismiss (8 s / click) |
| 3 | `03_power` ⚠ | Bootstrap power | Build power first — you have none. Water Wheel on coastal water, or Windmill on grass. | Water Wheel · 50 wood / 30 stone / 5 iron ingot · **water** — or Windmill · 80 wood / 20 stone / 3 iron ingot · **grass** | `hasBuilding([water_wheel, windmill_t0])` |
| 4 | `04_power_scale` `[C]` ⚠ | Scale your power | One source isn't enough — a Mine needs 25 kW, a Water Wheel makes 20 kW. Build several; output is throttled (brownout) until supply catches up. | (more Water Wheels / Windmills) | island produced ≥ 80 kW, or TTL |
| 5 | `05_quarry` | Renewable stone | Stone underpins every build — keep it flowing. | Quarry · 120 stone / 80 wood / 30 iron ingot · **stone** | `hasBuilding(quarry)` |
| 6 | `06_logger` | Renewable wood | Logger needs no power and keeps wood coming. | Logger · 30 stone / 30 wood / 10 iron ingot · **tree** | `hasBuilding(logger)` |
| 7 | `07_mine` | Extract ore & coal | Mines pull iron ore (ore vein) and coal (coal vein). | Mine · 200 stone / 80 wood · **ore / coal** | `hasBuilding(mine)` |
| 8 | `08_tile_gate` `[C]` | Tile-locked | Extractors only place where every footprint tile matches the resource — watch the green highlight. | — | TTL after a Mine exists |
| 9 | `09_clay` ⚠ | Clay for smelting | Clay lines the Smelter and feeds cement. Build on the clay pit. | Clay Pit Extractor · 140 stone / 80 wood · **clay_pit** | `hasBuilding(clay_pit_extractor)` |
| 10 | `10_smelter` | Smelt iron | 10 iron ore + 3 coal → 6 iron ingots — the Tier-2 backbone. | Smelter · 400 stone / 100 clay / 20 wood | `hasBuilding(smelter)` |
| 11 | `11_workshop` | Craft bolts | 1 iron ore + 1 coal → 1 bolt (maintenance & kits). | Workshop · 150 wood / 100 stone / 30 iron ingot | `hasBuilding(workshop)` |
| 12 | `12_adjacency` `[C]` | Adjacency buffs | Cluster same-type buildings for a +10% output bonus. | — | `hasAdjacentSameType`, or TTL |
| 13 | `13_storage` `[C]` | Storage caps | Each resource has a cap — build Crates to raise it. | Crate · 80 wood / 30 stone | `hasBuilding(crate)`, or TTL |
| 14 | `14_maintenance` `[C]` | Maintenance | Buildings need upkeep — the orange wrench means it's due. | — | TTL |
| 15 | `15_co2` `[C]` | CO₂ & climate | Your industry emits CO₂ (shown in the HUD). High totals worsen weather. | — | TTL |

### T1 → T2 — Drones, fuel, first expansion (Level 5 gate)

| # | id | mechanic | hint | place | advances when |
|---|---|---|---|---|---|
| 16 | `16_tier2` `[C]` | Reach Tier 2 | Production earns XP — push the home island to level 5 to unlock Tier 2. | — | `maxIslandLevel ≥ 5` |
| 17 | `17_concrete` | Bulk material: concrete | Stone + clay → concrete, the bulk material for every Tier-2 build. | Concrete Plant · 150 stone / 40 iron ingot / 40 wood / 20 clay | `hasBuilding(concrete_plant)` |
| 18 | `18_copper` | Copper | Copper ore → copper ingot (wire, electronics, cells). | Copper Mine · 150 stone / 80 wood / 30 iron ingot · **copper_vein**, then Copper Smelter · 200 stone / 80 iron ingot / 30 wood / 40 clay | `hasBuilding(copper_smelter)` |
| 19 | `19_glass` | Glass | Sand → glass (gears, electronics, T4 builds). | Sand Pit · 120 stone / 80 wood / 20 iron ingot · **sand**, then Glassworks · 200 stone / 40 wood / 30 iron ingot / 20 clay | `hasBuilding(glassworks)` |
| 20 | `20_gear` | Gears | 1 iron ingot + 2 bolts → 1 gear (drones, pumps, mills). | Assembler · 7000 concrete / 4000 stone / 2000 iron ingot / 500 glass / 300 copper ingot | `hasBuilding(assembler)` |
| 21 | `21_dronepad` | Drone pad | Scout the ocean with drones. | Drone Pad · 2000 concrete / 1000 stone / 500 iron ingot / 100 gear | `hasBuilding(dronepad)` |
| 22 | `22_biofuel` | Drone fuel | 2 wood → 1 biofuel — cheap T1 drone fuel. | Biofuel Plant · 150 stone / 60 wood / 40 iron ingot / 30 clay | `hasBuilding(biofuel_plant)` |
| 23 | `23_drone_launch` `[C]` | Launch a drone | Open Drone Ops (J), pick a T1 drone, arm, click a target tile. | — | first dispatch, or TTL |
| 24 | `24_oil` | Crude oil | Crude oil feeds lubricant & diesel. | Pump Jack · 7000 concrete / 4000 stone / 2000 iron ingot / 150 gear / 200 copper ingot · **oil_well** | `hasBuilding(pump_jack)` |
| 25 | `25_lubricant` | Maintenance materials | Refine lubricant from the oil chain — every maintenance cycle needs it. | Lubricant Refinery · 12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 3000 clay / 350 copper ingot | `hasBuilding(lubricant_refinery)` |
| 26 | `26_settle` | Settle a new island | Load fuel + a Foundation Kit and send a ship from a Shipyard. | Shipyard · 400 stone / 250 wood / 100 iron ingot | `settledCount ≥ 2` |
| 27 | `27_antenna` `[C]` | Stay connected | Antennas extend signal range so drones can transmit. | Antenna · 20 stone / 20 wood / 10 iron ingot / 5 copper ingot | `hasBuilding(antenna_t1)` |
| 28 | `28_kit_assembler` | Sustain Foundation Kits | 5 iron ingot + 10 wood + 5 bolt → 1 kit, to keep settling. | Kit Assembler · 150 stone / 60 wood / 40 iron ingot / 200 bolt | `hasBuilding(kit_assembler)` |

### T2 → T3 — Steel, electronics, advanced fuel (Level 15 gate)

| # | id | mechanic | hint | place | advances when |
|---|---|---|---|---|---|
| 29 | `29_tier3` `[C]` | Reach Tier 3 | Push an island to level 15 for the steel & electronics tier. | — | `maxIslandLevel ≥ 15` |
| 30 | `30_limestone` | Limestone flux | Limestone feeds the Blast Furnace. | Limestone Quarry · 150 stone / 80 wood / 30 iron ingot · **limestone** | `hasBuilding(limestone_quarry)` |
| 31 | `31_coke` | Coke | 10 coal → 7 coke for the steel chain. | Coke Oven · 15000 clay / 500 stone / 100 pipe | `hasBuilding(coke_oven)` |
| 32 | `32_pig_iron` | Pig iron | 35 iron ore + 18 coke + 10 limestone → 20 pig iron. (Needs adjacent heat — Coal Furnace / Geothermal.) | Blast Furnace · 30000 steel beam / 25000 clay / 2000 stone | `hasBuilding(blast_furnace)` |
| 33 | `33_heat_budget` `[C]` | Heat budget | Heat-using buildings need an adjacent heat source; one source feeds limited consumers. | Coal Furnace · 50 stone / 20 iron ingot / 30 wood | `hasBuilding(coal_furnace)`, or TTL |
| 34 | `34_steel` | Steel | 100 pig iron + quicklime + oxygen → 85 steel. | Steel Mill · 25000 steel beam / 8000 clay / 2000 stone | `hasBuilding(steel_mill)` |
| 35 | `35_wire` | Wire | 11 steel → 20 wire (electronics & cells). | Metal Rolling Mill · 12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 2500 clay / 400 copper ingot | `hasBuilding(metal_rolling_mill)` |
| 36 | `36_battery` `[C]` | Battery storage | Cell Press → saltwater cell; Battery Bank stores surplus (5 MWh) for night & brownouts. | Cell Press · 10 copper ingot / 2 iron ingot / 5 saltwater / 1 wood, then Battery Bank · 20 saltwater cell / 15 wire / 5 steel beam / 30 lead ingot | `hasBuilding(battery_bank)` |
| 37 | `37_silicon` | Silicon | Quartz → silicon. (Build the Quartz Mine on the **second** stone cluster.) | Quartz Mine · 150 stone / 80 wood / 30 iron ingot · **stone**, then Silicon Crusher · 350 steel beam / 5000 concrete / 100 gear / 50 pipe / 300 stone | `hasBuilding(silicon_crusher)` |
| 38 | `38_microchips` | Microchips | 1 silicon + 1 wire → 1 microchip — the core of all advanced tech. | Lithography Lab · 1500 steel beam / 20000 concrete / 500 glass / 200 wire | `hasBuilding(lithography_lab)` |
| 39 | `39_gases` | Industrial gases | Air → nitrogen + oxygen + argon. | Air Separator · 30 stone | `hasBuilding(air_separator)` |
| 40 | `40_hydrogen` | Hydrogen | 9 fresh water → 1 hydrogen + 8 oxygen (a Well supplies water). | Electrolyzer · 40 stone / 20 wood / 20 iron ingot / 10 copper ingot | `hasBuilding(electrolyzer)` |
| 41 | `41_biome` `[C]` | Biome dependencies | Some buildings are biome-locked: Pyroforge needs volcanic, the AI Core needs arctic. Settle accordingly. | — | TTL |

### T3 → T4 — Endgame industry (Level 30 gate)

| # | id | mechanic | hint | place | advances when |
|---|---|---|---|---|---|
| 42 | `42_tier4` `[C]` | Reach Tier 4 | Level an island to 30 for Tier-4 uniques. | — | `maxIslandLevel ≥ 30` |
| 43 | `43_quantum_chip` | Quantum chips | 4 steel + 4 pig iron → 1 quantum chip. | Quantum Chip Fab · 8000 steel beam / 4000 glass / 2000 microchip / 1000 ceramic insulator / 200 silicon wafer | `hasBuilding(quantum_chip_fab)` |
| 44 | `44_ai_core` | AI Core (arctic) | 3 steel + 1 quantum chip + 1 argon → 1 AI Core. Needs an **arctic** colony. | Cryogenic Compute Center · 15000 steel beam / 5000 ceramic insulator / 1000 microchip / 500 cryo coolant / 200 wire · **arctic** | `invAtLeast(ai_core, 1)` |
| 45 | `45_helium` | Helium-3 | Drill helium-3 for alloys & power. | Drilling Rig · 1000 steel beam / 12000 concrete / 300 pipe / 150 gear / 100 microchip · **helium_vent** | `hasBuilding(drilling_rig)` |
| 46 | `46_exotic_alloy` | Exotic alloy (volcanic) | 5 steel + 1 helium-3 → 1 exotic alloy. Needs a **volcanic** colony. | Pyroforge · 10000 steel beam / 3000 clay / 500 microchip / 200 ceramic insulator · **volcanic** | `hasBuilding(pyroforge)` |
| 47 | `47_antimatter` | Antimatter | 10 hydrogen + 1 exotic alloy + 5 microchip → 1 antimatter capsule. | Particle Accelerator · 25000 steel beam / 3000 concrete / 2000 magnet / 1000 microchip / 200 cryo coolant | `hasBuilding(particle_accelerator)` |
| 48 | `48_time_crystal` | Time crystals | 1 helium-3 + 1 exotic alloy → 1 time crystal. | Quantum Manipulator · 3000 steel beam / 1000 ceramic insulator / 500 cryo coolant / 300 microchip / 200 wire / 100 glass | `hasBuilding(quantum_manipulator)` |
| 49 | `49_weather` `[C]` | Weather & storms | Storms damage outdoor buildings; CO₂ worsens their frequency. Wastewater & scrubbers mitigate. | — | TTL |

### T4 → T5 — Transcendence (Level 50 + AI Core)

| # | id | mechanic | hint | place | advances when |
|---|---|---|---|---|---|
| 50 | `50_tier5` `[C]` | Reach Tier 5 | Level 50 + a crafted AI Core unlocks the Tier-5 capstone. | — | `maxIslandLevel ≥ 50 && aiCoreCrafted` |
| 51 | `51_reality_forge` | The Reality Forge | The Tier-5 capstone that forges Reality Anchors. | Reality Forge · 15000 steel beam / 5000 clay / 800 microchip / 500 ceramic insulator / 300 exotic alloy | `hasBuilding(reality_forge)` |
| 52 | `52_reality_anchor` | Reality Anchor | 4 AI Cores + 1 antimatter + 1 time crystal + 1 exotic alloy → 1 Reality Anchor (an 8-hour craft). | — | `invAtLeast(reality_anchor, 1)` |
| 53 | `53_beyond` `[C]` | Beyond | Reality Anchors gate the Ascendant path (T6, Spaceport) — the endgame opens from here. | — | dismiss |

---

## Decisions folded in (override on review if wrong)

- **XP bump per step:** kept.
- **Gear (Assembler) + Glass (Glassworks/Sand Pit) + Concrete:** added as explicit
  T2 material steps (they gate the Drone Pad / Pump Jack milestones).
- **Power-scaling / brownout step (#4):** added per the reachability finding.
- **Folded** (not separate steps): legacy `produce_*` "wait for X" steps, the
  diesel sub-chain, and per-resource T3 chemistry sub-steps — the build UI surfaces
  missing inputs, and milestone steps keep the chain ~53 vs ~150.
- **Kit Assembler** moved to step 28 (after the starter kit is spent) since the
  starter ships 1 foundation_kit — first settlement (#26) doesn't need it.

## Build sites that depend on the home 2nd-stone-cluster terrain change
Quarry (#5) and Quartz Mine (#37) both need a `'stone'` 2×2 — the terrain edit
(decision #8) is a prerequisite of this chain on the home island.

## Implementation surface (for the eventual plan)
- `island.ts` — add 2nd home stone cluster.
- `tutorial.ts` — replace `TUTORIAL_STEPS` with this chain (+ `targetDefId`),
  wire every trigger, delete `_OBJECTIVES`/`checkObjectives`/`xpBumpPercentForCompletion`
  re-homed onto steps; keep `currentStep`/`checkDismissals`/`markCompleted`/lifecycle.
- `tutorial-ui.ts` — remove `renderTutorialBanner`; move `.tutorial-hint` to the
  left corner; harden CSS (max-width / word-wrap / overflow).
- `main.ts` — drop the banner path (`checkObjectives`/`renderTutorialBanner`);
  keep `refreshTutorialHint` polling.
- Guard test: every step's `targetDefId`/`targetRecipeId` exists; stated tile
  matches the def's `requiredTile`.
- Tests: per-step trigger/dismissal; no `() => false`.

## OPEN for your review
1. The 53-step list above — reorder / cut / reword / add anything?
2. Any hint text too long for the card? (longest are #2 inventory, #3 power — flag if so.)
3. Keep the folded `produce_*` "wait" steps out, or restore key ones?
4. Concept-step TTLs vs dismiss-on-signal — acceptable as drafted?
