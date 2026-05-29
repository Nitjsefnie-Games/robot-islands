# Tutorial chain — final ordered step list (Task 1.1)

**Date:** 2026-05-29 · **Status:** authored, awaiting human sign-off (the spec the
Task 1.2 subagent encodes into `TUTORIAL_STEPS`).
**Supersedes the draft chain in:** `2026-05-29-tutorial-consolidation-design.md` (53 milestone steps).
**Verified against current code** via a programmatic dump of `BUILDING_DEFS`
(`src/building-defs.ts`) and `RECIPES` (`src/recipes.ts`) on branch
`tutorial-consolidation` — NOT against the draft's numbers. Every cost / tile /
recipe in the table below was read out of the live data; the **Discrepancy list**
(§B) records every place the draft disagreed with code.

---

## Conventions

- Each row is a `TutorialStep`: `id`, `mechanic` (bold label), `hint`
  (card-fit), `expectedAction` (the "Place X (cost) on tile" line, or `null`
  for concept/level/craft steps), `priority`, `targetDefId`
  (`BuildingDefId | null`), and the `triggerCondition` / `dismissalCondition`
  expressed in the existing `tutorial.ts` helpers (`hasBuilding`, `invAtLeast`,
  `invSeen`, `settledCount`, `maxIslandLevel`, `hasAdjacentSameType`,
  `hasAdjacentHeat`, `stepCompleted`).
- `[C]` = concept step (no build; `expectedAction: null`; dismiss on a related
  signal or a TTL via `stepCompleted`).
- **Tier gates:** T2 = island L5, T3 = L15, T4 = L30, T5 = L50 + AI Core. Helper:
  `maxIslandLevel(w) >= N`.
- **Costs are exact** from `placementCost`. **Recipes are exact** stoichiometry
  from `RECIPES[<key>]` (`cycleSec` deliberately NOT cited in hints — it is
  volatile under the throughput/floors pass).
- "prior step done" in a trigger means: the immediately-preceding chain step's
  dismissal predicate already holds (i.e. `markCompleted` fired for it). In the
  encoded form this is implicit — `currentStep` walks steps in array order and
  only surfaces the first un-completed step whose `triggerCondition` is true, so
  a step naturally waits for its predecessor. Where a step needs a stronger gate
  than array-order (e.g. a tier-level gate), the explicit predicate is given.

## Topological-completeness scope (READ THIS)

This chain is topologically complete **for the 30-building closure backbone the
design doc enumerated** — every building in that backbone is preceded by a step
introducing each of its prerequisite producers, in build order. It is **NOT**
strictly topologically complete for the single-producer feeder chains the draft
deliberately folded: lubricant chemistry (`naphtha_cracker` / `crude_oil_cracker`
→ heavy_oil; `chlor_alkali_plant` → chlorine; `chemical_reactor` + `sulfur_mine`
→ calcium_sulfonate), the battery saltwater feed (`coastal_pump` → saltwater),
and the cryo-coolant feed (`cryo_lab` → cryo_coolant). These producers are
**not** authored as explicit steps — the build UI surfaces missing inputs, and
the draft chose milestone steps over a ~150-step fully-expanded chain. **This is
OPEN question #5 (§C) — the human must confirm "fold vs. insert" per group.**

---

## §A. THE ORDERED CHAIN

Step numbers are the final encode order. The "draft #" column maps back to the
design doc's 53 (— = newly inserted producer/concept). `targetDefId` is the def
the step's trigger/dismiss keys on (`null` for concept/level/craft steps).

### T1 — Orientation, power, the iron chain (Level 1)

| # | draft# | id | mechanic | targetDefId | hint | expectedAction | priority | trigger → dismiss |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | `01_location` | **Location** | null | Click where you live — real sunrise & sunset follow real time at that spot. | (open the map picker, select lat/lon) | critical | trigger: `w.playerLat == null`; dismiss: `w.playerLat != null` |
| 2 | 2 | `02_inventory` `[C]` | **Your stockpile** | null | You start with 1200 stone, 600 wood, 30 iron ore, 80 coal, 60 iron ingots, 25 bolts, 15 limestone, 4 saltwater cells, 5000 scrap, 1 foundation kit. | null | recommended | trigger: prior done; dismiss: `stepCompleted('02_inventory', 8_000)` |
| 3 | 3 | `03_power` | **Bootstrap power** | water_wheel | Build power first — you have none. Water Wheel on coastal water, or Windmill on grass. | Place a Water Wheel (50 wood / 30 stone / 5 iron ingot) on **water** — or Windmill (80 wood / 20 stone / 3 iron ingot) on **grass**. | critical | trigger: `playerLat != null && !hasBuilding(['water_wheel','windmill_t0'])`; dismiss: `hasBuilding(['water_wheel','windmill_t0'])` |
| 4 | 4 | `04_power_scale` `[C]` | **Scale your power** | null | One source isn't enough — a Mine needs 25 kW, a Water Wheel makes 20 kW. Build several; output throttles (brownout) until supply catches up. | (more Water Wheels / Windmills) | recommended | trigger: `hasBuilding(['water_wheel','windmill_t0'])`; dismiss: `stepCompleted('04_power_scale', 30_000)` |
| 5 | 5 | `05_quarry` | **Renewable stone** | quarry | Stone underpins every build — keep it flowing. | Place a Quarry (120 stone / 80 wood / 30 iron ingot) on a **stone** 2×2. | critical | trigger: prior done && `!hasBuilding(['quarry'])`; dismiss: `hasBuilding(['quarry'])` |
| 6 | 6 | `06_logger` | **Renewable wood** | logger | Logger needs no power and keeps wood coming. | Place a Logger (30 stone / 30 wood / 10 iron ingot) on a **tree** tile. | critical | trigger: prior done && `!hasBuilding(['logger'])`; dismiss: `hasBuilding(['logger'])` |
| 7 | 7 | `07_mine` | **Extract ore & coal** | mine | Mines pull iron ore (ore vein) and coal (coal vein). | Place a Mine (200 stone / 80 wood) on an **ore** or **coal** vein. | critical | trigger: prior done && `!hasBuilding(['mine'])`; dismiss: `hasBuilding(['mine'])` |
| 8 | 8 | `08_tile_gate` `[C]` | **Tile-locked** | null | Extractors only place where every footprint tile matches the resource — watch the green highlight. | null | recommended | trigger: `hasBuilding(['mine'])`; dismiss: `stepCompleted('08_tile_gate', 12_000)` |
| 9 | 9 | `09_clay` | **Clay for smelting** | clay_pit_extractor | Clay lines the Smelter and feeds concrete & cement. Build on the clay pit. | Place a Clay Pit Extractor (140 stone / 80 wood) on **clay_pit**. | critical | trigger: prior done && `!hasBuilding(['clay_pit_extractor'])`; dismiss: `hasBuilding(['clay_pit_extractor'])` |
| 10 | 10 | `10_smelter` | **Smelt iron** | smelter | 10 iron ore + 3 coal → 6 iron ingots (+ slag + CO) — the Tier-2 backbone. | Place a Smelter (400 stone / 100 clay / 20 wood). | critical | trigger: `invAtLeast('iron_ore',10) && invAtLeast('coal',3) && !hasBuilding(['smelter'])`; dismiss: `hasBuilding(['smelter'])` |
| 11 | 11 | `11_workshop` | **Craft bolts** | workshop | 1 iron ore + 1 coal → 1 bolt (maintenance & kits). | Place a Workshop (150 wood / 100 stone / 30 iron ingot). | critical | trigger: prior done && `!hasBuilding(['workshop'])`; dismiss: `hasBuilding(['workshop'])` |
| 12 | 12 | `12_adjacency` `[C]` | **Adjacency buffs** | null | Cluster same-type buildings for a +10% output bonus. | null | recommended | trigger: `hasAdjacentSameType(w)`; dismiss: `stepCompleted('12_adjacency', 30_000)` |
| 13 | 13 | `13_storage` `[C]` | **Storage caps** | crate | Each resource has a cap — build Crates to raise it. | Place a Crate (80 wood / 30 stone). | recommended | trigger: prior done; dismiss: `hasBuilding(['crate','silo']) \|\| stepCompleted('13_storage', 20_000)` |
| 14 | 14 | `14_maintenance` `[C]` | **Maintenance** | null | Buildings need upkeep — the orange wrench means it's due. | null | recommended | trigger: prior done; dismiss: `stepCompleted('14_maintenance', 15_000)` |
| 15 | 15 | `15_co2` `[C]` | **CO₂ & climate** | null | Your industry emits CO₂ (shown in the HUD). High totals worsen weather. | null | recommended | trigger: `w.totalCo2Kg >= 100 \|\| prior done`; dismiss: `stepCompleted('15_co2', 15_000)` |

### T1 → T2 — Concrete, drones, fuel, first expansion (Level 5 gate)

> **Reorder vs draft (heat cascade + raw-extractor front-loading).** Task 0.4
> corrected concrete to `cement + sand + stone + water → concrete`. Concrete's real
> prerequisite closure pulls `limekiln` (quicklime) and `cement_mill` early, and
> **both are `requiresHeat: true`** — so the heat-budget concept + a `coal_furnace`
> must precede them. Verification then surfaced two ordering gaps the draft never
> had (it thought concrete was stone+clay): **`cement_mill` needs sand** (so
> `sand_pit` must precede it, not follow), and **`concrete_plant` needs fresh_water**
> (only producer is `well` — not in the starter; **`well` inserted here**, was
> draft-only at the hydrogen step). Final raw-first order: heat → limestone →
> quicklime → sand → water → cement → concrete. `limestone_quarry` (draft 30),
> `sand_pit` (draft 19), and `well` all move up as concrete prerequisites.

| # | draft# | id | mechanic | targetDefId | hint | expectedAction | priority | trigger → dismiss |
|---|---|---|---|---|---|---|---|---|
| 16 | 16 | `16_tier2` `[C]` | **Reach Tier 2** | null | Production earns XP — push the home island to level 5 to unlock Tier 2. | null | critical | trigger: prior done; dismiss: `maxIslandLevel(w) >= 5` |
| 17 | — | `17_heat_budget` `[C]` | **Heat budget** | coal_furnace | Heat-using buildings (Limekiln, Cement Mill, Coke Oven, Ceramic Kiln) need an adjacent heat source. One source feeds limited consumers. | Place a Coal Furnace (50 stone / 20 iron ingot / 30 wood). | critical | trigger: `maxIslandLevel(w) >= 5 && !hasBuilding(['coal_furnace'])`; dismiss: `hasBuilding(['coal_furnace','geothermal_vent','plasma_heater'])` |
| 18 | 30 | `18_limestone` | **Limestone flux** | limestone_quarry | Limestone feeds quicklime (cement & steel). | Place a Limestone Quarry (150 stone / 80 wood / 30 iron ingot) on **limestone**. | critical | trigger: prior done && `!hasBuilding(['limestone_quarry'])`; dismiss: `hasBuilding(['limestone_quarry'])` |
| 19 | — | `19_quicklime` | **Quicklime** | limekiln | 25 limestone → 14 quicklime. Needs adjacent heat. | Place a Limekiln (200 stone / 40 wood / 30 iron ingot / 50 clay) next to a Coal Furnace. | critical | trigger: prior done && `!hasBuilding(['limekiln'])`; dismiss: `hasBuilding(['limekiln'])` |
| 20 | 19 | `20_sand` | **Sand** | sand_pit | Sand → cement, glass, ceramics. | Place a Sand Pit (120 stone / 80 wood / 20 iron ingot) on **sand**. | critical | trigger: prior done && `!hasBuilding(['sand_pit'])`; dismiss: `hasBuilding(['sand_pit'])` |
| 21 | — | `21_water` | **Fresh water** | well | A Well draws fresh water for concrete, hydrogen, and chemistry. | Place a Well (20 stone / 20 wood / 5 iron ingot) on **water**. | critical | trigger: prior done && `!hasBuilding(['well'])`; dismiss: `hasBuilding(['well'])` |
| 22 | — | `22_cement` | **Cement** | cement_mill | 8 quicklime + 2 clay + 1 sand → 11 cement. Needs adjacent heat. | Place a Cement Mill (200 stone / 60 iron ingot / 30 wood) next to a Coal Furnace. | critical | trigger: prior done && `!hasBuilding(['cement_mill'])`; dismiss: `hasBuilding(['cement_mill'])` |
| 23 | 17 | `23_concrete` | **Bulk material: concrete** | concrete_plant | cement + sand + stone + water → concrete, the bulk material for every Tier-2 build. (1 cement + 2 sand + 3 stone + 0.5 water → 6 concrete.) | Place a Concrete Plant (150 stone / 40 iron ingot / 40 wood / 20 clay). | critical | trigger: prior done && `!hasBuilding(['concrete_plant'])`; dismiss: `hasBuilding(['concrete_plant'])` |
| 24 | 18 | `24_copper` | **Copper** | copper_smelter | Copper ore → copper ingot (wire, electronics, cells). | Place a Copper Mine (150 stone / 80 wood / 30 iron ingot) on **copper_vein**, then a Copper Smelter (200 stone / 80 iron ingot / 30 wood / 40 clay). | critical | trigger: prior done && `!hasBuilding(['copper_smelter'])`; dismiss: `hasBuilding(['copper_smelter'])` |
| 25 | 19 | `25_glass` | **Glass** | glassworks | Sand → glass (electronics, T4 builds). | Place a Glassworks (200 stone / 40 wood / 30 iron ingot / 20 clay). | recommended | trigger: prior done && `!hasBuilding(['glassworks'])`; dismiss: `hasBuilding(['glassworks'])` |
| 26 | 20 | `26_gear` | **Gears** | assembler | 1 iron ingot + 2 bolts → 1 gear (drones, pumps, mills). | Place an Assembler (7000 concrete / 4000 stone / 2000 iron ingot / 500 glass / 300 copper ingot). | critical | trigger: prior done && `!hasBuilding(['assembler'])`; dismiss: `hasBuilding(['assembler'])` |
| 27 | 21 | `27_dronepad` | **Drone pad** | dronepad | Scout the ocean with drones. | Place a Drone Pad (2000 concrete / 1000 stone / 500 iron ingot / 100 gear). | recommended | trigger: prior done && `!hasBuilding(['dronepad'])`; dismiss: `hasBuilding(['dronepad'])` |
| 28 | 22 | `28_biofuel` | **Drone fuel** | biofuel_plant | 2 wood → 1 biofuel — cheap T1 drone fuel. | Place a Biofuel Plant (150 stone / 60 wood / 40 iron ingot / 30 clay). | recommended | trigger: prior done && `!hasBuilding(['biofuel_plant'])`; dismiss: `hasBuilding(['biofuel_plant'])` |
| 29 | 23 | `29_drone_launch` `[C]` | **Launch a drone** | null | Open Drone Ops (J), pick a T1 drone, arm, click a target tile. | null | recommended | trigger: `hasBuilding(['dronepad'])`; dismiss: `(w.drones.length > 0) \|\| stepCompleted('29_drone_launch', 30_000)` |
| 30 | 24 | `30_oil` | **Crude oil** | pump_jack | Crude oil feeds lubricant & diesel. | Place a Pump Jack (7000 concrete / 4000 stone / 2000 iron ingot / 150 gear / 200 copper ingot) on **oil_well**. | recommended | trigger: prior done && `!hasBuilding(['pump_jack'])`; dismiss: `hasBuilding(['pump_jack'])` |
| 31 | 25 | `31_lubricant` | **Maintenance materials** | lubricant_refinery | Refine lubricant for every maintenance cycle. (5 heavy_oil + 5 chlorine + 1 calcium_sulfonate → 10 lubricant — the cracker / chlor-alkali / chemical chains feed it; the build palette shows what's missing.) | Place a Lubricant Refinery (12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 3000 clay / 350 copper ingot). | recommended | trigger: prior done && `!hasBuilding(['lubricant_refinery'])`; dismiss: `hasBuilding(['lubricant_refinery'])` |
| 32 | 26 | `32_settle` | **Settle a new island** | shipyard | Load fuel + a Foundation Kit and send a ship from a Shipyard. | Place a Shipyard (400 stone / 250 wood / 100 iron ingot) on a coastal tile, then settle. | critical | trigger: prior done; dismiss: `settledCount(w) >= 2` |
| 33 | 27 | `33_antenna` `[C]` | **Stay connected** | antenna_t1 | Antennas extend signal range so drones can transmit. | Place an Antenna (20 stone / 20 wood / 10 iron ingot / 5 copper ingot). | recommended | trigger: prior done; dismiss: `hasBuilding(['antenna_t1','antenna_t2','antenna_t3']) \|\| stepCompleted('33_antenna', 20_000)` |
| 34 | 28 | `34_kit_assembler` | **Sustain Foundation Kits** | kit_assembler | 5 iron ingot + 10 wood + 5 bolt → 1 kit, to keep settling. | Place a Kit Assembler (150 stone / 60 wood / 40 iron ingot / 200 bolt). | recommended | trigger: prior done && `!hasBuilding(['kit_assembler'])`; dismiss: `hasBuilding(['kit_assembler'])` |

### T2 → T3 — Steel, electronics, advanced fuel (Level 15 gate)

> **Steel bootstrap (inserted).** `blast_furnace` costs **30000 steel_beam** and
> `steel_mill` costs **25000 steel_beam** — a circular dependency the rev-17
> starter `scrap: 5000` breaks. The chain teaches the bootstrap explicitly:
> seeded scrap → `steel_mill_scrap` (2 scrap → 1 steel) → `beam_mill`
> (105 steel → 2 steel_beam) → steel_beam, which lets the player afford the
> blast furnace / steel mill, after which pig-iron-fed `steel_mill` self-sustains.
> `air_separator` (oxygen, step 40) and the limekiln (quicklime, taught in T2)
> both precede `steel_mill` (step 42) since steel needs
> `100 pig_iron + 7 quicklime + 9 oxygen`.

| # | draft# | id | mechanic | targetDefId | hint | expectedAction | priority | trigger → dismiss |
|---|---|---|---|---|---|---|---|---|
| 35 | 29 | `35_tier3` `[C]` | **Reach Tier 3** | null | Push an island to level 15 for the steel & electronics tier. | null | critical | trigger: prior done; dismiss: `maxIslandLevel(w) >= 15` |
| 36 | — | `36_scrap_steel` | **Bootstrap steel from scrap** | steel_mill_scrap | Your 5000 starter scrap bootstraps steel: 2 scrap → 1 steel. | Place a Scrap Steel Mill (20000 concrete / 15000 stone / 8000 iron ingot / 500 gear / 5000 clay / 500 copper ingot). | critical | trigger: `maxIslandLevel(w) >= 15 && !hasBuilding(['steel_mill_scrap'])`; dismiss: `hasBuilding(['steel_mill_scrap'])` |
| 37 | — | `37_beams` | **Steel beams** | beam_mill | 105 steel → 2 steel beams — the structural input every steel-tier building needs in bulk. | Place a Beam Mill (10000 concrete / 6000 stone / 3000 iron ingot / 200 gear / 2000 clay / 200 copper ingot). | critical | trigger: prior done && `!hasBuilding(['beam_mill'])`; dismiss: `hasBuilding(['beam_mill'])` |
| 38 | — | `38_pipes` | **Pipes** | pipe_mill | 42 steel → 10 pipes (Coke Oven, rigs, chemistry). | Place a Pipe Mill (10000 concrete / 7000 stone / 3500 iron ingot / 250 gear / 2500 clay / 300 copper ingot). | recommended | trigger: prior done && `!hasBuilding(['pipe_mill'])`; dismiss: `hasBuilding(['pipe_mill'])` |
| 39 | 31 | `39_coke` | **Coke** | coke_oven | 10 coal → 7 coke (+ byproducts) for the steel chain. Needs adjacent heat. | Place a Coke Oven (15000 clay / 500 stone / 100 pipe) next to a heat source. | critical | trigger: prior done && `!hasBuilding(['coke_oven'])`; dismiss: `hasBuilding(['coke_oven'])` |
| 40 | — | `40_oxygen` | **Industrial gases** | air_separator | Air → nitrogen + oxygen + argon. Oxygen feeds the steel mill; argon feeds the AI Core. | Place an Air Separator (30 stone). | critical | trigger: prior done && `!hasBuilding(['air_separator'])`; dismiss: `hasBuilding(['air_separator'])` |
| 41 | 32 | `41_pig_iron` | **Pig iron** | blast_furnace | 35 iron ore + 18 coke + 10 limestone → 20 pig iron. Needs adjacent heat. | Place a Blast Furnace (30000 steel beam / 25000 clay / 2000 stone) next to a heat source. | critical | trigger: prior done && `!hasBuilding(['blast_furnace'])`; dismiss: `hasBuilding(['blast_furnace'])` |
| 42 | 34 | `42_steel` | **Steel** | steel_mill | 100 pig iron + 7 quicklime + 9 oxygen → 85 steel. | Place a Steel Mill (25000 steel beam / 8000 clay / 2000 stone). | critical | trigger: prior done && `!hasBuilding(['steel_mill'])`; dismiss: `hasBuilding(['steel_mill'])` |
| 43 | — | `43_slag` `[C]` | **Reclaim slag** | slag_reprocessor | Smelting slag → gold / silver / rare earth. Rare earth feeds magnets. | Place a Slag Reprocessor (8000 concrete / 6000 stone / 2000 iron ingot / 300 gear / 400 copper ingot). | optional | trigger: prior done && `!hasBuilding(['slag_reprocessor'])`; dismiss: `hasBuilding(['slag_reprocessor']) \|\| stepCompleted('43_slag', 20_000)` |
| 44 | 35 | `44_wire` | **Wire** | metal_rolling_mill | 11 steel → 20 wire (electronics & cells). | Place a Metal Rolling Mill (12000 concrete / 7000 stone / 4000 iron ingot / 250 gear / 2500 clay / 400 copper ingot). | recommended | trigger: prior done && `!hasBuilding(['metal_rolling_mill'])`; dismiss: `hasBuilding(['metal_rolling_mill'])` |
| 45 | — | `45_lead` | **Lead** | lead_smelter | Lead ore → lead ingot for Battery Bank plates. | Place a Lead Mine (150 stone / 80 wood / 30 iron ingot) on **lead_vein**, then a Lead Smelter (200 stone / 80 iron ingot / 30 wood / 40 clay). | recommended | trigger: prior done && `!hasBuilding(['lead_smelter'])`; dismiss: `hasBuilding(['lead_smelter'])` |
| 46 | 36 | `46_battery` | **Battery storage** | battery_bank | Cell Press → saltwater cell; Battery Bank stores surplus for night & brownouts. (Cell Press needs saltwater — a Coastal Pump supplies it; see OPEN #5.) | Place a Cell Press (10 copper ingot / 2 iron ingot / 5 saltwater / 1 wood), then a Battery Bank (20 saltwater cell / 15 wire / 5 steel beam / 30 lead ingot). | recommended | trigger: prior done && `!hasBuilding(['battery_bank'])`; dismiss: `hasBuilding(['battery_bank'])` |
| 47 | 37 | `47_silicon` | **Silicon** | silicon_crusher | Quartz → silicon. Build the Quartz Mine on the **second** stone cluster. | Place a Quartz Mine (150 stone / 80 wood / 30 iron ingot) on **stone**, then a Silicon Crusher (350 steel beam / 5000 concrete / 100 gear / 50 pipe / 300 stone). | recommended | trigger: prior done && `!hasBuilding(['silicon_crusher'])`; dismiss: `hasBuilding(['silicon_crusher'])` |
| 48 | 38 | `48_microchips` | **Microchips** | lithography_lab | 1 silicon + 1 wire → 1 microchip — the core of all advanced tech. | Place a Lithography Lab (1500 steel beam / 20000 concrete / 500 glass / 200 wire). | recommended | trigger: prior done && `!hasBuilding(['lithography_lab'])`; dismiss: `hasBuilding(['lithography_lab'])` |
| 49 | — | `49_wafers` | **Silicon wafers** | wafer_lab | 1 silicon → 1 wafer (Quantum Chip Fab input). | Place a Wafer Lab (800 steel beam / 12000 concrete / 300 glass / 100 microchip / 150 wire). | recommended | trigger: prior done && `!hasBuilding(['wafer_lab'])`; dismiss: `hasBuilding(['wafer_lab'])` |
| 50 | — | `50_ceramics` | **Ceramic insulators** | ceramic_kiln | 2 clay + 1 sand → 1 ceramic insulator (T4 builds). Needs adjacent heat. | Place a Ceramic Kiln (5000 concrete / 4000 stone / 1200 iron ingot / 80 gear / 2000 clay) next to a heat source. | recommended | trigger: prior done && `!hasBuilding(['ceramic_kiln'])`; dismiss: `hasBuilding(['ceramic_kiln'])` |
| 51 | — | `51_magnets` | **Magnets** | mag_forge | Rare earth → magnetic alloy → magnet (Particle Accelerator). | Place a Mag Alloyer (500 steel beam / 6000 concrete / 200 ceramic insulator / 100 pipe / 50 microchip), then a Mag Forge (600 steel beam / 7000 concrete / 250 ceramic insulator / 100 pipe / 60 microchip). | optional | trigger: prior done && `!hasBuilding(['mag_forge'])`; dismiss: `hasBuilding(['mag_forge'])` |
| 52 | 40 | `52_hydrogen` | **Hydrogen** | electrolyzer | 9 fresh water → 1 hydrogen + 8 oxygen (your Well supplies water). | Place an Electrolyzer (40 stone / 20 wood / 20 iron ingot / 10 copper ingot) — the Well from step 21 feeds it. | recommended | trigger: prior done && `!hasBuilding(['electrolyzer'])`; dismiss: `hasBuilding(['electrolyzer'])` |
| 53 | 41 | `53_biome` `[C]` | **Biome dependencies** | null | Some buildings are biome-locked: Pyroforge needs volcanic, the AI Core needs arctic. Settle accordingly. | null | recommended | trigger: prior done; dismiss: `stepCompleted('53_biome', 20_000)` |

### T3 → T4 — Endgame industry (Level 30 gate)

| # | draft# | id | mechanic | targetDefId | hint | expectedAction | priority | trigger → dismiss |
|---|---|---|---|---|---|---|---|---|
| 54 | 42 | `54_tier4` `[C]` | **Reach Tier 4** | null | Level an island to 30 for Tier-4 uniques. | null | critical | trigger: prior done; dismiss: `maxIslandLevel(w) >= 30` |
| 55 | 43 | `55_quantum_chip` | **Quantum chips** | quantum_chip_fab | 4 steel + 4 pig iron → 1 quantum chip. | Place a Quantum Chip Fab (8000 steel beam / 4000 glass / 2000 microchip / 1000 ceramic insulator / 200 silicon wafer). | recommended | trigger: prior done && `!hasBuilding(['quantum_chip_fab'])`; dismiss: `hasBuilding(['quantum_chip_fab'])` |
| 56 | 44 | `56_ai_core` | **AI Core (arctic)** | cryogenic_compute_center | 3 steel + 1 quantum chip + 1 argon → 1 AI Core. Needs an **arctic** colony. (Cryo coolant: a Cryo Lab supplies it; see OPEN #5.) | Place a Cryogenic Compute Center (15000 steel beam / 5000 ceramic insulator / 1000 microchip / 500 cryo coolant / 200 wire) on an **arctic** island. | critical | trigger: prior done; dismiss: `invAtLeast('ai_core', 1)` |
| 57 | 45 | `57_helium` | **Helium-3** | drilling_rig | Drill helium-3 for alloys & power. | Place a Drilling Rig (1000 steel beam / 12000 concrete / 300 pipe / 150 gear / 100 microchip) on **helium_vent**. | recommended | trigger: prior done && `!hasBuilding(['drilling_rig'])`; dismiss: `hasBuilding(['drilling_rig'])` |
| 58 | 46 | `58_exotic_alloy` | **Exotic alloy (volcanic)** | pyroforge | 5 steel + 1 helium-3 → 1 exotic alloy. Needs a **volcanic** colony + adjacent heat. | Place a Pyroforge (10000 steel beam / 3000 clay / 500 microchip / 200 ceramic insulator) on a **volcanic** island, next to a heat source. | recommended | trigger: prior done && `!hasBuilding(['pyroforge'])`; dismiss: `hasBuilding(['pyroforge'])` |
| 59 | 47 | `59_antimatter` | **Antimatter** | particle_accelerator | 10 hydrogen + 1 exotic alloy + 5 microchip → 1 antimatter capsule. | Place a Particle Accelerator (25000 steel beam / 3000 concrete / 2000 magnet / 1000 microchip / 200 cryo coolant). | recommended | trigger: prior done && `!hasBuilding(['particle_accelerator'])`; dismiss: `hasBuilding(['particle_accelerator'])` |
| 60 | 48 | `60_time_crystal` | **Time crystals** | quantum_manipulator | 1 helium-3 + 1 exotic alloy → 1 time crystal. | Place a Quantum Manipulator (3000 steel beam / 1000 ceramic insulator / 500 cryo coolant / 300 microchip / 200 wire / 100 glass). | recommended | trigger: prior done && `!hasBuilding(['quantum_manipulator'])`; dismiss: `hasBuilding(['quantum_manipulator'])` |
| 61 | 49 | `61_weather` `[C]` | **Weather & storms** | null | Storms damage outdoor buildings; CO₂ worsens their frequency. Wastewater & scrubbers mitigate. | null | recommended | trigger: prior done; dismiss: `stepCompleted('61_weather', 20_000)` |

### T4 → T5 — Transcendence (Level 50 + AI Core)

| # | draft# | id | mechanic | targetDefId | hint | expectedAction | priority | trigger → dismiss |
|---|---|---|---|---|---|---|---|---|
| 62 | 50 | `62_tier5` `[C]` | **Reach Tier 5** | null | Level 50 + a crafted AI Core unlocks the Tier-5 capstone. | null | critical | trigger: prior done; dismiss: `maxIslandLevel(w) >= 50 && invSeen('ai_core')` |
| 63 | 51 | `63_reality_forge` | **The Reality Forge** | reality_forge | The Tier-5 capstone that forges Reality Anchors. | Place a Reality Forge (15000 steel beam / 5000 clay / 800 microchip / 500 ceramic insulator / 300 exotic alloy). | recommended | trigger: prior done && `!hasBuilding(['reality_forge'])`; dismiss: `hasBuilding(['reality_forge'])` |
| 64 | 52 | `64_reality_anchor` | **Reality Anchor** | null | 4 AI Cores + 1 antimatter capsule + 1 time crystal + 1 exotic alloy → 1 Reality Anchor (a long craft). | null | recommended | trigger: `hasBuilding(['reality_forge'])`; dismiss: `invAtLeast('reality_anchor', 1)` |
| 65 | 53 | `65_beyond` `[C]` | **Beyond** | null | Reality Anchors gate the Ascendant path (T6, Spaceport) — the endgame opens from here. | null | optional | trigger: `invAtLeast('reality_anchor', 1)`; dismiss: `stepCompleted('65_beyond', 15_000)` |

**Total: 65 steps** — the draft's 53, **+12 inserted** (9 producer steps + 3
concept/structural). Inserted: `17_heat_budget` (concept, moved-up + re-homed),
`19_quicklime` (limekiln), `21_water` (well — surfaced during verification: concrete
needs fresh_water, only producer is `well`, not in starter), `22_cement` (cement_mill),
`36_scrap_steel` (steel_mill_scrap), `37_beams` (beam_mill), `38_pipes` (pipe_mill),
`40_oxygen` (air_separator), `43_slag` (slag_reprocessor), `49_wafers` (wafer_lab),
`50_ceramics` (ceramic_kiln), `51_magnets` (mag_alloyer→mag_forge). `sand_pit` and
`limestone_quarry` were already draft steps — they moved earlier, not added.

---

## §B. DISCREPANCY LIST (draft vs current code) — HUMAN GATE

Every place the design draft's numbers / tiles / recipes disagreed with the live
data. **Not silently fixed to the draft** — the table reflects code; these are
the conflicts the human must confirm.

| # | Item | Draft said | Code says | Resolution in this spec |
|---|---|---|---|---|
| D1 | **Starter inventory** | "…60 iron ingots, 25 bolts, 15 limestone, 4 saltwater cells, 1 foundation kit" — **no scrap** | `startingInventory()`: stone 1200, wood 600, iron_ore 30, coal 80, iron_ingot 60, bolt 25, limestone 15, saltwater_cell 4, **scrap 5000**, foundation_kit 1 (everything else 0; **no copper_ingot, no clay, no steel**) | Step 2 hint updated to include **5000 scrap**. |
| D2 | **Concrete recipe** | `{cement:1, sand:2, stone:3, fresh_water:0.5} → {concrete:6}` (Task 0.4 already corrected the original stone+clay error) | `concrete_plant`: `{cement:1, sand:2, stone:3, fresh_water:0.5} → {concrete:6}` ✓ | Matches. Hint = "cement + sand + stone + water → concrete". |
| D3 | **Concrete prereqs are heat-gated** | Draft never noted this (thought concrete was stone+clay) | `cement_mill` **requiresHeat:true**, `limekiln` **requiresHeat:true**. Concrete needs cement←quicklime←limestone, plus sand, water. | **Reordered**: heat-budget + `coal_furnace` (17), `limestone_quarry` (18), `limekiln` (19), `sand_pit` (20), `well` (21), `cement_mill` (22) all precede `concrete_plant` (23). Single largest structural change. |
| D4 | **Lubricant recipe** | (legacy hints) "crude oil + chlorine → lubricant" | `lubricant_refinery`: `{heavy_oil:5, chlorine:5, calcium_sulfonate:1} → {lubricant:10}` | Hint corrected. **The 3 feeder chains (heavy_oil, chlorine, calcium_sulfonate) are folded, NOT inserted** — see OPEN #5. |
| D5 | **calcium_sulfonate producer** | Reachability prep proposed `sulfur + quicklime + heavy_oil → calcium_sulfonate` at chemistry building | `chemical_reactor`: `{sulfur:1, quicklime:1, heavy_oil:1} → {calcium_sulfonate:3}` ✓ (Task 0.2 shipped) | Confirmed exists; folded (not an explicit step). |
| D6 | **steel_mill_scrap recipe key** | Reachability prep called it the "steel_mill_scrap" bootstrap | Two keys exist: `steel_mill_scrap` AND `steel_mill_from_scrap`, **identical** (`{scrap:2}→{steel:1, slag:1}`). `steel_mill_scrap` is the placeable `BuildingDefId`; `steel_mill_from_scrap` is the runtime `resolveRecipe` substitution variant. | Step 36 targets defId `steel_mill_scrap`. |
| D7 | **Steel-building steel_beam costs** | Draft step 32 "Blast Furnace 30000 steel beam", step 34 "Steel Mill 25000 steel beam" | `blast_furnace` 30000 steel_beam; `steel_mill` 25000 steel_beam ✓ | Matches — but **confirms the circularity** the scrap bootstrap (steps 36-37) resolves. |
| D8 | **Reality Anchor recipe** | Draft step 52: "4 AI Cores + 1 antimatter + 1 time crystal + 1 exotic alloy → 1 Reality Anchor (an 8-hour craft)" | `reality_forge`: `{ai_core:4, antimatter_capsule:1, time_crystal:1, exotic_alloy:1} → {reality_anchor:1}`, **cycleSec 42999.7 (~12h, not 8h)** | Recipe matches; **"8-hour" duration claim dropped** (softened to "a long craft" — cycleSec is volatile). |
| D9 | **air_separator recipe** | Draft step 39: "Air → nitrogen + oxygen + argon" | `air_separator`: `{air:100} → {nitrogen:75.5, oxygen:23.2, argon:1.3}`. `air` is exogenous (atmosphere input). | Matches. Moved **before** steel_mill (step 40 < 42) since steel needs oxygen. |
| D10 | **Tier framing of T1 buildings** | Draft narrated concrete_plant / copper / glassworks / biofuel / electrolyzer as T2/T3 | All are coded **tier:1**: `concrete_plant`, `copper_mine`, `copper_smelter`, `glassworks`, `biofuel_plant`, `electrolyzer` (also `limekiln`, `cement_mill`, `lead_smelter`, `limestone_quarry`, `quartz_mine`, `sand_pit`, `clay_pit_extractor` = T1) | Hints carry **no tier gating** for these — they're buildable pre-L5. Placed post-L5 in the chain only for pacing, not because they're gated. |
| D11 | **quartz_mine tile** | Draft step 37: "build on the second stone cluster" | `quartz_mine.requiredTile: ['stone']` ✓ (Task 0.3 added a 2nd home stone 2×2) | Matches; hint names the **second** stone cluster. |
| D12 | **copper_mine tile** | Draft step 18: "copper-ore tile" | `copper_mine.requiredTile: ['copper_vein']` ✓ | Matches. |
| D13 | **lead_mine tile** | Draft did not list lead as a step | `lead_mine.requiredTile: ['lead_vein']`; `battery_bank` cost includes 30 lead_ingot | **Inserted** `45_lead` (lead_mine→lead_smelter) before the Battery Bank (46). |
| D14 | **sulfur source** | Reachability prep: home had no sulfur; added `sulfur_vein` cluster | `sulfur_mine.requiredTile: ['sulfur_vein']` ✓ (Task 0.3). Sulfur feeds `chemical_reactor` (calcium_sulfonate). | Confirmed; folded into the lubricant chemistry (OPEN #5). |
| D15 | **assembler cost** | Draft step 20: "7000 concrete / 4000 stone / 2000 iron ingot / 500 glass / 300 copper ingot" | `assembler`: `{concrete:7000, stone:4000, iron_ingot:2000, glass:500, copper_ingot:300}` ✓ | Matches. Note: gear needs the Assembler, which needs **glass + copper** — so glass (25) & copper (24) precede gears (26). |
| D16 | **particle_accelerator cycleSec** | n/a | `cycleSec: 1` — almost certainly a **data placeholder/bug** (every neighbor is thousands–millions of seconds) | Flagged to human (out of scope for this doc; recipe stoichiometry is correct). |
| D17 | **glassworks cycleSec** | n/a | `cycleSec: 22337.5` — very slow vs other T1 (informational, not a chain error) | Noted; not a tutorial-chain issue. |
| **D18** | **Concrete needs fresh_water — no early producer** | Draft never noted water had a producer gap | `concrete_plant` input `fresh_water:0.5`; only producer is `well` (`{}→fresh_water:1`), **not in starter inventory**. Draft introduced `well` only at the hydrogen step (far after concrete). | **Inserted `21_water` (well)** before concrete (23). Was the second ordering break the heat-cascade reorder surfaced. |
| **D19** | **cement_mill needs sand — sand_pit was after it** | Draft ordered sand_pit (19) before cement, but had cement before sand in this spec's first draft | `cement_mill` input `sand:1`; only sand producer is `sand_pit`. | **Reordered**: `sand_pit` (20) now precedes `cement_mill` (22). |
| **D20** | **saltwater / cryo_coolant have single producers, folded** | Draft did not list a saltwater or cryo_coolant producer step | `saltwater` ← `coastal_pump` ONLY (starter has only 4 saltwater_cell; `cell_press` needs saltwater to make more); `cryo_coolant` ← `cryo_lab` ONLY (needed by cryogenic_compute_center, particle_accelerator, quantum_manipulator) | **Folded, not inserted** — same fold policy as the lubricant chemistry. Flagged in OPEN #5. Build UI surfaces the missing input. |

---

## §C. RESOLVED design-doc OPEN questions (1–4) + new ones

The design doc closed with 4 OPEN questions. Resolutions baked into this chain:

1. **Reorder / cut / reword / add?** — Added 12 steps (closure producers + steel
   bootstrap + heat concept + well), reordered the T1→T2 region for the concrete
   heat cascade + raw-extractor front-loading (D3/D18/D19), moved limestone/sand/well
   earlier. No draft step cut.
2. **Hint text too long for the card?** — Longest hints are step 2 (inventory)
   and step 31 (lubricant). Both are within the card budget but flagged as the
   tightest. The lubricant hint folds the 3-feeder explanation into one clause.
3. **Restore folded `produce_*` "wait" steps?** — Kept folded. Production-wait is
   implicit (a build step's dismiss keys on `hasBuilding`; the next step's
   trigger waits on array order). Two exceptions intentionally use `invAtLeast`
   on output (steps 56 AI Core, 64 Reality Anchor — craft milestones with no
   building of their own).
4. **Concept-step TTLs vs dismiss-on-signal?** — Both used: concept steps with a
   natural signal (`12_adjacency` → `hasAdjacentSameType`; `29_drone_launch` →
   `w.drones.length>0`) dismiss on signal **or** TTL; pure-info steps
   (`08_tile_gate`, `14_maintenance`, `53_biome`, `61_weather`, `65_beyond`) use
   a `stepCompleted` TTL only.

### NEW open questions surfaced during verification

5. **Lubricant / chemistry / saltwater / cryo sub-chains are folded, not inserted** —
   so the chain is topologically complete only for the 30-building closure, NOT for
   these single-producer feeders the build UI surfaces:
   - `lubricant_refinery` (step 31) ← `naphtha_cracker`/`crude_oil_cracker` (heavy_oil),
     `chlor_alkali_plant` (chlorine ← salt+water), `chemical_reactor` (calcium_sulfonate ←
     sulfur+quicklime+heavy_oil) — see D4/D5/D14.
   - `cell_press` / Battery Bank (step 46) ← `coastal_pump` (saltwater) — see D20.
   - cryogenic_compute_center / particle_accelerator / quantum_manipulator (56/59/60)
     ← `cryo_lab` (cryo_coolant) — see D20.
   **Confirm for each group: fold (build-UI surfaces missing inputs) or insert the producer?**
6. **`particle_accelerator` cycleSec = 1** (D16) — almost certainly a data bug
   (produces 1 antimatter capsule per simulated second). Fix in a `recipes.ts`
   pass — out of scope here, but it makes antimatter trivially free. Confirm.
7. **Reality Anchor duration** (D8) — code is ~12h, draft said 8h. The hint now
   says "a long craft." Confirm whether a concrete duration belongs in the hint
   given cycleSec volatility.
8. **`steel_mill_scrap` vs `steel_mill_from_scrap`** (D6) — both recipe keys
   exist and are identical. Confirm the encoder should target the **placeable**
   `steel_mill_scrap` defId (the `_from_scrap` key is the runtime substitution
   variant `resolveRecipe` selects on a pig-iron-less Steel Mill, not a placeable).
9. **Quicklime / oxygen before steel** — the chain teaches `limekiln` at step 19
   (T2, for cement) and `air_separator` at step 40 (T3), both before `steel_mill`
   (42). An alternative oxygen source is the T1 `electrolyzer` (`9 fresh_water →
   1 hydrogen + 8 oxygen`); the task explicitly chose `air_separator` for steel's
   oxygen, so that's encoded. Confirm air_separator vs electrolyzer for steel O₂.

---

## §D. Encoding notes for Task 1.2

- Add `targetDefId?: BuildingDefId` to `TutorialStep`. Steps with `null`
  (concept/level/craft) omit it.
- All triggers/dismissals use only the existing helpers — no new predicate
  primitives required. `prior done` compiles to array-order (no explicit guard)
  except where a `maxIslandLevel`/`invSeen`/`invAtLeast`/`hasBuilding` gate is
  shown.
- The guard test (Task 1.2 Step 1) will pass: every `targetDefId` above is a
  real key in `BUILDING_DEFS`, and every `requiredTile` named in a hint matches
  the def's `requiredTile` (verified: quarry/quartz_mine→stone, logger→tree,
  mine→ore/coal, clay_pit_extractor→clay_pit, sand_pit→sand, limestone_quarry→
  limestone, copper_mine→copper_vein, lead_mine→lead_vein, pump_jack→oil_well,
  drilling_rig→helium_vent, water_wheel/well→water, windmill_t0→grass).
- `cryogenic_compute_center` (arctic) and `pyroforge` (volcanic) carry
  `requiredBiomes` — the hint names the biome but the dismiss keys on the
  output/building, not the biome (the player picks a colony).
```
