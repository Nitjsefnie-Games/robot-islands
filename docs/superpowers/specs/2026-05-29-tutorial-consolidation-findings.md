# Tutorial Consolidation — findings & locked design (PAUSED)

**Status:** Brainstorm paused mid-flight to run the energy SI rebalance first.
Resume from here. Date: 2026-05-29.

## Why this exists

The running app shows **two tutorials at once** with conflicting instructions
(e.g. banner "Power Up → Wind Turbine" vs overlay "Bootstrap power → Water
Wheel"). Root cause: two independent guidance systems, both wired into the
`main.ts` ticker:

- **Phase-7 hint overlay** — `refreshTutorialHint()` → `currentStep()` over
  `TUTORIAL_STEPS` (32 steps), rendered as `.tutorial-hint` (`main.ts:2100`).
  Content is aligned with the post-rework economy.
- **Legacy objective banner** — `renderTutorialBanner()` → `checkObjectives()`
  over `_OBJECTIVES` (~50 entries), rendered as `#tutorial-banner`
  (`main.ts:1862`). Content is **stale** (its first objective tells the player
  to build a `wind_turbine` for "30 steel, 10 wood" — real cost is
  `steel_beam 800 / aluminum 50 / stone 200 / magnet 5 / wire 30`, an
  impossible first build = softlock).

Both live in `src/tutorial.ts`. Phase 7 kept `_OBJECTIVES` for "backward-compat"
and never removed the banner path.

## Locked decisions (user-approved)

1. **Single source of truth = Phase-7 overlay framework.** Remove the legacy
   banner: drop `renderTutorialBanner` + `checkObjectives` from the ticker;
   delete `_OBJECTIVES` / `checkObjectives` / `renderTutorialBanner` after
   porting their `check()` predicates into step triggers.
2. **List shape:** legacy granular chain as the **spine**, Phase-7 mechanic
   concepts folded in. One ordered list, full depth **T0→T5**, every step with
   a wired trigger.
3. **Content sourcing:** **static, hand-verified** strings (costs/recipes
   copied from `building-defs.ts` / `recipes.ts` at authoring time). Add a
   guard test: every step's `targetDefId` / `targetRecipeId` **exists** and the
   step's stated required tile **matches** the def's `requiredTile`.
4. **Depth:** full granular chain through T5 (Reality Forge → Reality Anchor).
5. **First steps order:** location picker → **starting-inventory orientation**
   → bootstrap power → renewable materials generation (quarry/logger/mine).
6. **Overlay position:** move `.tutorial-hint` to the **LEFT** corner (it
   currently covers the right-side buttons). Harden CSS — `max-width`,
   `word-wrap`, padding, overflow — and keep every hint **concise** so no step
   clips. (The reported overflow was actually the *content* being wrong, not
   just long; see "freshwater" below.)
7. **Trigger wiring:** replace every `() => false` stub in `TUTORIAL_STEPS`
   (lines ~60/68/76/110/129/178 + the `recentBuildAttempts` TODO at ~83) with
   real predicates built from the existing helpers (`hasBuilding`,
   `invAtLeast`, `settledCount`, `maxIslandLevel`, `hasAdjacentSameType`, …).
8. **Stone-slot conflict resolution:** **add a second 2×2 `stone` cluster to
   the home island** terrain so Quarry + Quartz Mine can coexist (see below).

### Open / undecided
- **Per-step XP bump** (legacy `xpBumpPercentForCompletion`): proposed to keep
  as "part of the experience the banner gave." Not confirmed.
- Whether to restore any **dropped** legacy steps as explicit steps (the
  `produce_*` "wait" steps, diesel sub-chain, T3 chem sub-steps were folded).
- Whether to add an explicit **"Gears: Assembler"** step before the Drone Pad
  (gear is a hidden prerequisite).
- **NEW (must add): a "Scale your power / brownout" step** right after Bootstrap
  Power — see the starting-inventory analysis; one power source is not enough.

## Correctness findings (the real point of this pass)

This is fundamentally a **correctness** rewrite — the tutorial must match the
real game (tiles, costs, recipes, building existence, reachability).

### The "freshwater" bug (representative)
Phase-7 step 02 says "place on the freshwater cluster." There is **no
freshwater tile** — `water_wheel.requiredTile = ['water']`. The home water
cluster is tile-type `'water'`; comments mislabel it "fresh-water" (there's a
`fresh_water` *resource* from a Well, but no such tile). → All texts must use
real tile names.

### Legacy chain gap: Smelter needs clay, no clay step
`smelter` costs `stone 400 / clay 100 / wood 20`, but the starter has **0 clay**
and the legacy chain had no "get clay" step. → **Insert a Clay Pit Extractor
step before the Smelter** (`clay_pit_extractor`, `stone 140 / wood 80`, tile
`clay_pit`).

### Home island terrain map (verified, `island.ts` `defaultTerrainAt`)
| tile | location | feeds |
|---|---|---|
| ore (6 tiles) | (-7..-5, 2..3) | Mine → iron_ore |
| coal 2×2 | (8..9, 5..6) | Mine → coal |
| tree 2×2 | (6..7, -3..-4) | Logger |
| water 2×2 | (-1..0, -5..-4) | Water Wheel / Well / Coastal Pump |
| clay_pit 2×2 | (5..6, 7..8) | Clay Pit Extractor |
| copper_vein 2×2 | (-7..-6, -6..-7) | Copper Mine |
| limestone 2×2 | (-9..-8, 7..8) | Limestone Quarry |
| oil_well 2×2 | (-4..-3, 8..9) | Pump Jack |
| sand 2×2 | (10..11, -1..0) | Sand Pit |
| **stone 2×2** | (-11..-10, 4..5) | **Quarry OR Quartz Mine (conflict)** |
| grass | everywhere else | Windmill + all tile-none buildings |

### Quarry / Quartz Mine stone-slot contention
Both are 2×2 (`SHAPES.square2`) and both `requiredTile: ['stone']`. Home has
exactly one 2×2 stone patch → mutually exclusive. There is no `'quartz'` tile;
`quartz_mine` piggybacks on `'stone'`. Procedural islands scatter `'stone'` as
single tiles (won't fit a 2×2) except mountain/arctic (stone-default).
**Resolution chosen: add a second home stone cluster** (decision 8).

### Starting-inventory reachability
Starter (rev-9, `world.ts startingInventory`): stone 1200, wood 600,
iron_ore 30, coal 80, iron_ingot 60, bolt 25, limestone 15, saltwater_cell 4,
foundation_kit 1.

**Verdict: just-sufficient to start, but power-bound — not material-bound.**
- `iron_ingot` (60) is the tightest material, but the iron-replenishers — Mine,
  Clay Pit, Smelter — cost **0 iron_ingot**, so iron production is always
  bootstrappable. No iron softlock.
- First settlement is free: starter includes **1 foundation_kit** (no need for
  the 200-bolt Kit Assembler to start).
- **Power is the binding constraint.** Supply: Windmill 15, Water Wheel 20.
  Draw: Mine 25, Quarry 30, Clay Pit 30, Smelter 50, Workshop 60. One source
  can't fully run even one Mine. Full early set ≈ 200 → ~13 windmills ≈ 1000+
  wood vs 600 starter. Saved by: power deficit **throttles** (`factor =
  min(1, produced/consumed)`, not a hard stop) and the **Logger draws 0 power**
  (free wood), so the ramp climbs out. This is the deferred rev-17 reachability
  gate (rev-9 → battery_bank in 45 min FAILED).
- Player starts with **zero power buildings placed** → first build MUST be
  power (confirms decision 5 ordering).

## Proposed full chain (T0→T5) — for review when resuming

~51 steps; ⚠ = correction from legacy, `[C]` = concept/info step. Hints kept
short for card fit; exact cost in the "Place" column. (Full table was produced
in-session; reproduce from the legacy `_OBJECTIVES` order + Phase-7 concepts,
corrected against the verified `building-defs.ts` values and the home terrain
above. Key corrections already identified: ⚠ bootstrap power = Water Wheel
(water tile) / Windmill (grass), NOT Wind Turbine; ⚠ insert Clay Pit before
Smelter; tier gates T2=L5, T3=L15, T4=L30, T5=L50+aiCoreCrafted.)

**This table must be fully written out and re-approved before implementation —
the user will not accept the spec without the complete chain incl. texts.**

## Map-picker work COMPLETED this session (already merged into working tree)
- Replaced placeholder world map with real Natural Earth land outline
  (`countries-110m` merge), projected via d3-geo to the 360×180 plate-carrée
  viewBox; fixed antimeridian artifacts.
- Added country borders (`mesh(a≠b)`, `fill:none` + `non-scaling-stroke`).
- Scroll-zoom + drag-pan via viewBox; pointer-based click-vs-drag picking;
  fixed pin coordinate bug; **red pin** marker.
- Centered the Confirm button text.
- `scripts/gen-map-path.mjs` regenerates the asset; `d3-geo` + `topojson-client`
  added as devDependencies. Tests green (14 in `map-picker.test.ts`).
- NOTE: moving the *tutorial* overlay to the left corner (decision 6) is NOT
  yet done — that's part of the tutorial implementation, not the map-picker.

## Related deferred follow-ups (surfaced during this pass)
- **Action costs not SI-rescaled:** `terrain_modifier`, `land_reclamation_hub`,
  `platform_constructor` had placement BOMs rescaled in Phase 4 but their
  **operation costs** remain pre-SI placeholders (land reclamation `5·r²` stone;
  platform constructor still spends `steel` ×5/tile, not `steel_beam`).
- **Energy units (NOW being fixed in the energy rebalance pass):** the SI rework
  defined "1 unit power = 100 kW" (§2.1) but never applied it; power values are
  raw abstract numbers, and the HUD (`hud.ts:577`) labels them `"W"` — so a
  water wheel reads "20W" when the anchor implies 2 MW (and the spec's own
  realism note says 20 kW). Being addressed next.
