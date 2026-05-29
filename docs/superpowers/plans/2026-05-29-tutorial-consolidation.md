# Tutorial Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development, on `master`. Steps use checkbox (`- [ ]`). Each commit ends with the implementer's `Co-Authored-By` trailer.
>
> **⚠ CONCURRENCY:** the throughput/floors rebalance is running on `master` in parallel and edits `recipes.ts`, `building-defs.ts`, `world.ts`. This plan also touches `recipes.ts` (calcium_sulfonate), `world.ts` (starter + home spec), `island.ts`. Do each edit as a small, current-`master` commit; if a file moved under you, re-read before editing. Never `git add -A` — stage only this plan's files.

**Goal:** Replace the two competing tutorial systems with one — the Phase-7 hint overlay driven by a single, full-supply-chain `TUTORIAL_STEPS` — after making that chain actually buildable (reachability prep).

**Architecture:** Phase 0 fixes game reachability (seed scrap, add calcium_sulfonate producer, enlarge + re-node the home island, fix the concrete-recipe hint). Phase 1 rewrites `TUTORIAL_STEPS` as the topologically-complete chain (milestones + inserted prerequisite producers) with wired triggers and `targetDefId`, and deletes the legacy `_OBJECTIVES`/`checkObjectives`/`renderTutorialBanner` path. Phase 2 wires `main.ts` to the overlay only and moves the hint UI to the left corner. Phase 3 guards + re-verifies.

**Spec:** `docs/superpowers/specs/2026-05-29-tutorial-consolidation-design.md` (chain content, reachability prep, closure backbone).

**Test commands:** `npx vitest run <file>` · `npm test` · `npx tsc --noEmit` · `npm run build` · step-verifier: see Phase 3.

---

## PHASE 0 — Reachability prep (must land before the chain)

### Task 0.1 — Seed `scrap` in the rev-9 starter

**Files:** `src/world.ts` (`startingInventory`); `src/world.test.ts`/persistence tests if they assert the starter.

- [ ] **Step 1 (test):** assert `startingInventory().scrap` is a positive seed (e.g. `=== 5000`).
- [ ] **Step 2:** in `startingInventory()` add `inv.scrap = 5000; // §rev-17 salvage cache — bootstraps the steel chain (scrap → steel_mill_scrap → steel → beam_mill → steel_beam)`.
- [ ] **Step 3:** run; fix any starter-inventory fixture; commit `feat(tutorial): seed starter scrap to bootstrap the steel chain`.
- [ ] **NOTE (tracked, not solved here):** the seed breaks the *circular* dependency only. Reaching the steel tier in reasonable time still depends on the steel-building BOM magnitudes (blast_furnace 30 000 steel_beam; beam_mill ~52 steel → 2 steel_beam) + the throughput/floors pace. If playtest shows the steel grind is unreachable, the fix is a BOM/ratio reduction (rev-17), **not** a bigger seed. Flag to the human after Phase 3.

### Task 0.2 — `calcium_sulfonate` producer recipe (mass-balanced)

**Files:** `src/recipes.ts` (new recipe); `src/mass-balance.test.ts` will enforce balance.

- [ ] **Step 1:** add a recipe producing `calcium_sulfonate` on an existing chemistry building (recommend `chemical_reactor`): inputs `sulfur + quicklime + heavy_oil`, output `calcium_sulfonate`, **mass-balanced** (output kg = input kg; tune quantities until the mass-balance auditor passes — add `RECIPE_SPECULATIVE`/`exogenousFlow` only if genuinely warranted, which it is not here). cycleSec will be set by the throughput generator (its archetype = acids/chemistry).
- [ ] **Step 2:** run `npx vitest run src/mass-balance.test.ts` → must stay green (the new recipe balances). Confirm `densityForRecipe`/archetype coverage if the throughput module is present.
- [ ] **Step 3:** commit `feat(tutorial): add mass-balanced calcium_sulfonate producer (closes lubricant-chain gap)`.

### Task 0.3 — Home terrain: enlarge + add stone-2 and sulfur_vein

**Files:** `src/world.ts` (`makeHomeIslandSpec` radii); `src/island.ts` (`defaultTerrainAt` clusters); `src/island.test.ts`/`world` tests.

- [ ] **Step 1 (test):** assert home radii are 16; assert `defaultTerrainAt` returns `'stone'` at the new 2nd-cluster tiles and `'sulfur_vein'` at the new sulfur tiles (pick tile coords inside the r16 disk, clear of all existing clusters and home-building anchors — list them in the test).
- [ ] **Step 2:** in `makeHomeIslandSpec` set `majorRadius: 16, minorRadius: 16`. In `island.ts defaultTerrainAt`, add a second 2×2 `stoneClusterTiles2` and a 2×2 `sulfurTiles`, and add their lookups (return `'stone'` / `'sulfur_vein'`). Choose coords clear of every existing cluster (ore/coal/tree/water/oil_well/limestone/copper_vein/clay_pit/sand/stone) and inside r16.
- [ ] **Step 3:** run; confirm the procedural layout still generates neighbors (overlap-detect against the larger home — no hand-placed neighbors exist, so just verify a sane spread). `tsc` clean. Commit `feat(tutorial): home island r14->r16 + 2nd stone cluster + sulfur_vein`.

### Task 0.4 — Fix the concrete-recipe hint source + tier-framing data

**Files:** none yet (these are chain-content fixes applied in Phase 1) — but record here so Phase 1 uses the correct facts:
- Step-17 concrete hint = **"cement + sand + stone + water → concrete"** (verified `concrete_plant` recipe `{cement:1,sand:2,stone:3,fresh_water:0.5}→{concrete:6}`), NOT "stone + clay". Its prereqs (`cement_mill`, `sand_pit`) must precede it in the chain.
- These buildings are coded `tier:1` (buildable pre-L5): `concrete_plant`, `copper_mine`, `copper_smelter`, `glassworks`, `biofuel_plant`, `electrolyzer` — don't narrate them as gated T2/T3.

---

## PHASE 1 — Full-supply-chain `TUTORIAL_STEPS` rewrite

### Task 1.1 — Author the chain content (design → final ordered step list)

**Files:** none (authoring artifact) — produce the final ordered `TUTORIAL_STEPS` content from the design doc.

- [ ] **Step 1:** Take the design doc's 53 milestone steps and **insert the closure prerequisite producers** in build order before their consumers (from the 30-building closure): `lead_smelter`, `beam_mill` (+ the scrap→steel_mill_scrap→steel bootstrap as explicit steps), `pipe_mill`, `ceramic_kiln`, `slag_reprocessor`, `mag_alloyer`→`mag_forge`, `wafer_lab`, `cement_mill` (before concrete), `limekiln`→quicklime (before steel/calcium_sulfonate), `air_separator`→oxygen (before steel_mill). Apply the Task 0.4 corrections (concrete hint; tier framing). Each step carries `{id, mechanic, hint, expectedAction, targetDefId, triggerCondition, dismissalCondition, priority}`. Hints in the existing concise card-fit style; verify every cost/tile/recipe against `building-defs.ts`/`recipes.ts` as you write (this is the spec the user must accept — get it reviewed).
- [ ] **Step 2:** Get the authored chain reviewed/approved (it's the spec content), then proceed to encode it.

### Task 1.2 — Encode `TUTORIAL_STEPS` + delete legacy objective path

**Files:** `src/tutorial.ts`; `src/tutorial.test.ts`.

- [ ] **Step 1 (test):** add a **guard test** — for every step with a `targetDefId`, `BUILDING_DEFS[targetDefId]` exists, and if the hint/step states a required tile it matches the def's `requiredTile`; every step has non-stub `triggerCondition`/`dismissalCondition` (no `() => false`). Run → FAIL (old steps).
- [ ] **Step 2:** replace `TUTORIAL_STEPS` with the Task 1.1 chain; add `targetDefId?: BuildingDefId` to `TutorialStep`; wire each trigger/dismissal from the existing helpers (`hasBuilding`, `invAtLeast`, `settledCount`, `maxIslandLevel`, `hasAdjacentSameType`, `stepCompleted`). **Delete** `_OBJECTIVES`, `checkObjectives`, and re-home `xpBumpPercentForCompletion` as a per-step XP bump applied on dismissal (keep the bump). Keep `currentStep`/`checkDismissals`/`markCompleted`/`skipAll`/`restart`.
- [ ] **Step 3:** run the guard + existing `tutorial.test.ts` (update/replace the old objective tests); remove the 3 `it.skip` "Phase 5 wire-up" stubs now that triggers are wired. `tsc` clean.
- [ ] **Step 4:** commit `feat(tutorial): full-supply-chain TUTORIAL_STEPS + wired triggers; remove legacy _OBJECTIVES`.

---

## PHASE 2 — Wire to overlay only + left-corner UI

### Task 2.1 — `main.ts`: drop the banner path

**Files:** `src/main.ts`.

- [ ] **Step 1:** remove the `checkObjectives`/`renderTutorialBanner`/`lastRenderedObjective` block (~1834–1870) and the `#tutorial-banner` DOM handling; keep `refreshTutorialHint(worldState)` (~2100) and the per-step XP-bump application (move it next to `checkDismissals`/`markCompleted` if it lived in the banner block). Update the import on line 116/117 (drop `checkObjectives`, `renderTutorialBanner`).
- [ ] **Step 2:** `tsc` clean; `npm test`; commit `refactor(tutorial): main.ts drives the hint overlay only (banner path removed)`.

### Task 2.2 — `tutorial-ui.ts`: remove banner, move hint to left corner, harden CSS

**Files:** `src/tutorial-ui.ts`.

- [ ] **Step 1:** delete `renderTutorialBanner`. Reposition `.tutorial-hint` to the **bottom-left** corner; add `max-width`, `word-wrap/overflow-wrap`, padding, and overflow handling so no hint clips (the original "freshwater"/long-text overlap bug). Keep `refreshTutorialHint` + the `renderedStepId` thrash guard.
- [ ] **Step 2:** `tsc` clean; `npm run build`; commit `feat(tutorial): hint overlay to left corner + clip-proof CSS; drop banner renderer`.

---

## PHASE 3 — Re-verify + green gate

### Task 3.1 — Re-run the step-verifier on the new chain

- [ ] **Step 1:** dispatch the step-verification check (as in the prior verifier run): every step's `targetDefId` exists, cost/tile/recipe/biome/tier match code, the chain is reachable in build order (prereq of each step introduced earlier), home terrain supports the early tiles. Fix any mismatch in `tutorial.ts`.
- [ ] **Step 2:** commit any fixes `test(tutorial): step-verifier clean on full-supply-chain chain`.

### Task 3.2 — Green gate + browser

- [ ] **Step 1:** `npm test` green, `tsc` clean, `npm run build` ok.
- [ ] **Step 2:** build + reload `https://islands.nitjsefni.eu/`; screenshot: exactly **one** tutorial overlay, bottom-left, not covering the right-side buttons; correct first steps (location → inventory → power → materials); a step auto-advances on placing its target building; no legacy "Wind Turbine" banner.
- [ ] **Step 3:** commit fixups `test(tutorial): single overlay verified in-browser`.

---

## Out of scope / flagged
- **Steel-beam BOM grind** (Task 0.1 note): if the steel tier is still unreachably slow after the throughput/floors pass, reduce the T3 steel-building BOMs / beam_mill ratio (rev-17). Raise to the human after Phase 3.
- The throughput/floors pass will change `cycleSec`; tutorial hints cite recipe *stoichiometry* (stable) not cycleSec, so no rework expected — but the "scale power / brownout" pacing hint may want a tweak once floors land.
- The 8-hour human playtest (rev-16 §11.4) remains the manual gate after this lands.
