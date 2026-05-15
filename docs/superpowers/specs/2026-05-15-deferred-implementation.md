# Implement everything deferred — content gap closure

> Date: 2026-05-15. Goal: bring code to parity with SPEC.md §6-§7-§8 deferred
> content. SPEC.md is locked (Appendix B explicitly out of scope: prestige,
> mechanical/steam, blueprints, multi-device sync, localization). All commits
> on `master`. Tier-bottom-up so each batch's inputs exist by the time its
> consumers ship.

## Current state (2026-05-15 baseline = 66a93ee)

- 72 ResourceIds in `src/recipes.ts`
- 69 recipes in `RECIPES`
- 109 BuildingDefIds in `src/building-defs.ts`
- 1199 tests pass

## Out of scope

- SPEC.md Appendix B items (prestige, steam, blueprints, sync, localization).
- Appendix A tuning placeholders (those need playthrough data).
- Anything that requires SPEC.md edits — spec is locked.

## Scope = every spec-mentioned item not yet in code

Tracked in dependency-tier batches. Each batch is one Kimi dispatch
(implementation + tests + commit). After all batches: 3 parallel opus agents
do balance review.

### Tier 1 (T0 raws + T1 refined) — unblocks T2 chains

**T0 raws to add (extractor buildings + tiles + extractor recipes):**
- `copper_ore`, `tin_ore`, `lead_ore`, `nickel_ore`, `chromium_ore`,
  `zinc_ore`, `manganese_ore`, `cobalt_ore`, `tungsten_ore`, `titanium_ore`
- `bauxite` (aluminum input)
- `limestone`, `clay` (construction/glass/chemistry inputs)
- `sulfur`, `phosphate` (chemistry inputs)
- `graphite` (electronics input)

**T1 refined:**
- `quicklime` (limestone + heat → quicklime)
- `slaked_lime` (quicklime + water → slaked_lime)
- `brick` (clay + heat → brick)
- `mortar` (sand + quicklime → mortar)
- `cement` (quicklime + sand + clay → cement)
- `concrete` (cement + sand + fresh_water → concrete)
- `charcoal` (wood + heat → charcoal)
- `copper_ingot` (copper_ore + coal → copper_ingot)
- `tin_ingot`, `lead_ingot`, `nickel_ingot`, `chromium_ingot`, `zinc_ingot`,
  `manganese_ingot`, `cobalt_ingot`, `tungsten_ingot`, `titanium_ingot`,
  `aluminum` (bauxite/alumina → aluminum) — group by smelter variant
- `solder` (lead + tin → solder)
- `plank` (wood → plank, fewer wood than lumber)

Buildings needed: extractor variants of `Mine` for each new ore tile, plus
new T1 refining buildings:
- `limekiln` (heat-required, limestone → quicklime)
- `lime_slaker` (quicklime + water → slaked_lime)
- `brick_kiln` (heat-required, clay → brick)
- `mortar_mixer` (sand + quicklime → mortar)
- `cement_mill` (quicklime + sand + clay → cement)
- `concrete_plant` (cement + sand + water → concrete)
- `charcoal_kiln` (wood → charcoal, heat-required)

### Tier 2 — most of §7.x chains

**T2 resources:**
- `carbon_steel` (steel + manganese)
- `galvanized_steel` (steel + zinc)
- `bronze` (copper + tin)
- `brass` (copper + zinc)
- `aluminum`, `alumina` (bauxite chain — alumina is T2 even though bauxite is T0)
- `plastic_precursor`, `rigid_plastic`, `flexible_plastic`, `synthetic_rubber`
- `sulfuric_acid`, `hydrochloric_acid`, `sodium_hydroxide`
- `heavy_oil`, `tar`, `asphalt`
- `heavy_cable`, `sheet_metal`, `steel_beam`, `pipe`
- `bearing`, `spring`
- `battery`
- `glass_panel`
- `coolant`
- `ceramic_insulator`

Buildings:
- `rolling_mill` (steel → sheet_metal / pipe / steel_beam — engine 1:1
  so split into per-output buildings)
- `bearing_press` (steel → bearing)
- `spring_winder` (steel → spring)
- `cracker_v2` (crude_oil → heavy_oil + tar + asphalt)
- `plastic_polymerizer` (plastic_precursor → rigid_plastic, etc.)
- `battery_factory` (lithium + plastic + electrolyte → battery)
- (existing `electrolyzer` reused for aluminum from alumina; existing
  `chemical_reactor` reused for sulfuric_acid + alumina)

### Tier 3 — advanced + electronics

**T3 raws (extractors):**
- `lithium`, `mercury`, `diamond_ore`
- `cryogenic_compound`

**T3 refined / components:**
- `stainless_steel`, `tool_steel`, `magnetic_alloy`
- `silicon_wafer`
- `optical_glass`, `glass_fiber`, `optical_fiber`
- `transistor`, `capacitor`, `resistor`
- `memory_module`
- `magnet`
- `electric_motor`, `generator`
- `hydraulic_actuator`, `pneumatic_actuator`, `pump`
- `solar_cell`, `fuel_cell`
- `liquid_nitrogen`, `phosphor`

Buildings: `wafer_lab` (silicon → wafer), `doping_chamber` (wafer + impurity → transistor / capacitor / resistor — split per output), `pcb_press`, `mag_forge` (rare_earth → magnet), `motor_assembly` (magnet + wire + steel → motor), `solar_cell_lab`, `fuel_cell_lab`, etc.

### Tier 4 — endgame chains

- `antimatter_capsule` (particle_accelerator)
- `nuclear_fuel_rod` (uranium_ore-based)
- `plasma_containment_vessel`
- `particle_accelerator_core`
- `cryo_containment_unit`
- `singularity_sensor`
- `self_replication_module`
- `time_crystal` (T4 raw)

### Tier 5 — transcendent capabilities

- `probability_calculator`
- `dimensional_fold`
- `causal_regulator`
- `singularity_battery` (resource — building already exists?)
- `tachyonic_transmitter`
- `lattice_node` (recipe — building already exists)
- `aether_beacon`
- `universe_editor` (recipe — building already exists)
- `reality_engine`
- `zero_point_flux`, `neutronium` (T5 raws)

### §14.10 — satellite assembly recipes

Wire `scanner_sat`, `comm_sat`, `sweeper_sat`, `repair_drone`,
`orbital_insertion_package`, `repair_pack` through actual `RECIPES` instead
of placeholder "payload-only" handling.

### §12.3 Foundation Kit Enriched / Refined variants

Enriched and Refined variants per spec — they're per-tier recipes.

### §6.7 Scrap-in-Steel substitution

The 2 Scrap = 1 Pig iron substitution in the Steel Mill recipe per §6.7.

### Bootstrap-pacing fix

User noticed lubricant is unreachable in 12h. Two options:
- **Option A**: add `oil_well` seeded terrain to home Plains (mirrors the
  tree + 2x2 stone seed pattern from `b3859b9`).
- **Option B**: bump T1 maintenance threshold from 12h → 24h.

Option A is more elegant — keeps the existing maintenance schedule honest
while making the chain reachable. Ship as part of Tier 1 batch.

## Execution plan

1. Tier 1 batch (T0 raws + T1 refined + new tile types + extractor/refiner
   buildings). Probably ~10-15 new resources + 8-12 buildings. One commit.
   Single Kimi dispatch.
2. Tier 2 batch — chemistry + alloys + petrochemical + mechanical components.
   ~15-20 new resources + 10-15 buildings.
3. Tier 3 batch — electronics + mechanical + cryogenic + minerals.
   ~15-20 new resources + 10-15 buildings.
4. Tier 4 batch — endgame chains.
   ~5-8 new resources + 5 buildings.
5. Tier 5 batch — transcendent components + missing recipes for existing
   T5 buildings.
6. §14.10 satellite-assembly recipes.
7. §12.3 Foundation Kit variants.
8. Misc DEFERRED-marker cleanup pass.
9. **Balance review**: 3 parallel opus agents with distinct lenses
   (progression-pacing / resource-graph audit / cost-tuning sanity). Union
   findings.
10. **Rebalance round 1**: apply union; re-run agents.
11. If round-2 finds new issues: ship as-is + document residual concerns.

Per batch: failing tests first; npm test + npm run build clean; commit on
master with the Kimi co-author trailer.

Hard rule: at no point should a recipe input not be producible by some
existing recipe / extractor. If a Tier-N batch references something only
defined in Tier-N+1, reject and reorder.
