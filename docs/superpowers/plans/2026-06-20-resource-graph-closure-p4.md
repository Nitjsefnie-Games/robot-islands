# Resource-Graph Closure P4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every one of the 40 remaining `expansion-hook` orphan resources a real sink (recipe consumer → `'consumed'`, or non-recipe sink → `'gameplay-sink'`), closing the recipe graph so the mass-balance auditor + terminal-consistency tests stay green and the orphan ledger reaches 0.

**Architecture:** Each orphan is closed by one of three mechanisms — (a) **tag-only** retag where a consumer already exists in `src`, (b) **recipe consumer** (new refine recipe or recipe-input add) tagged `'consumed'` and mass-balanced (or `RECIPE_SPECULATIVE` for fantasy), (c) **non-recipe sink** (placement cost / fuel) tagged `'gameplay-sink'`. Every chain that introduces a new dependency is validated deadlock-free before it lands: bootstrap-reachable chains against the faithful planner (`scripts/bootstrap_test.py`), non-bootstrap chains against the recipe-closure screen.

**Tech Stack:** TypeScript strict (client `src/`), vitest, Python 3 (planner/closure tooling), Postgres (server suite, unaffected).

## Global Constraints

- **terminal taxonomy (SPEC §7, `src/recipes.ts:1073`):** `terminal: 'consumed' | 'gameplay-sink' | \`expansion-hook:${string}\``. `'consumed'` ⇒ ≥1 recipe **input** consumer (gated by `recipes.test.ts`); `'gameplay-sink'` ⇒ a non-recipe sink (placement cost, fuel ladder, orbital) and is NOT gate-checked; `expansion-hook:` ⇒ declared orphan (the thing we are eliminating).
- **Mass balance (`src/mass-balance.test.ts`):** every recipe in `RECIPES` must satisfy `Σ(inputs.n · massPerUnitKg) === Σ(outputs.n · massPerUnitKg)` (float tolerance). Exempt: entries in `RECIPE_SPECULATIVE`, recipes using `rotateOutputs`, and pre-Phase-2 legacy skips. 220 of ~240 resources are `massPerUnitKg: 1`, so balance is usually integer unit-count balance.
- **`RECIPE_SPECULATIVE` (`src/recipes.ts:1340`):** `Readonly<Partial<Record<RecipeId, 'fantasy chemistry' | 'narrative cost' | true>>>`. Use ONLY for genuine fantasy chemistry (no real stoichiometry).
- **1:1 recipe-per-building:** a NEW refine recipe needs a host building (`BUILDING_DEFS` + `BuildingDefId` union) OR a `resolveRecipe` variant on an existing under-used building. New buildings also touch `KNOWN_DEF_IDS` (`src/building-defs.test.ts:30`), `RESOURCE_STORAGE_CATEGORY` (`src/storage-categories.ts:50`) for any new resource, `recipe-density.ts` (`BUILDING_ARCHETYPE`), and tier/unlock wiring.
- **Decision: minimize new buildings.** Prefer recipe-input adds + `resolveRecipe` variants over new buildings. Add a building only when no existing host fits.
- **Decision: XP weight inherits producer tier.** A new consumer recipe's produced resource gets `XP_WEIGHT` (`src/recipes.ts:730`) matching the producing tier (T0=1, T1=3, T2=10, …); existing products keep their weight.
- **Decision: byproduct loops only if no deadlock.** Validate each against `scripts/bootstrap_test.py`; keep only if it still prints `>>> Full target build placed` (never `!! BLOCKED`).
- **Decision: endgame fuels (`antimatter_propellant`, `plasma_charge`) = `gameplay-sink`.**
- **Deadlock rule (P3 lesson, MANDATORY):** never gate a building behind a component (placement cost or recipe input) whose own output is upstream of that component. Bootstrap-reachable chains are validated by the planner (multi-producer-correct); non-bootstrap chains by the closure screen, reading a flag as "verify an acyclic producer exists / the consumer is off the producer's critical path."
- **SPEC moves with code (`AGENTS.md`):** every behavior change updates `SPEC.md` §7 closure note (`SPEC.md:774`) in the same commit. `tsc -b` EXCLUDES `*.test.ts` — run the full `vitest` client suite, not just `tsc`.
- **Integration (`CONTRIBUTING.md`):** P4 is large → feature branch `p4-resource-graph-closure` cut from `master`, linear history, rebase + fast-forward to integrate. `master` stays green.

---

## Validation Tooling (set up once, before Phase 1)

### Task 0: Make the deadlock-validation tooling durable + baselines green

**Files:**
- Modify: `scripts/bootstrap_test.py` (already a working playground copy of `bootstrap_planner_v3.py`; revert the Phase-1 prototype edits so it tracks live `src` between runs, OR keep a clean copy — see Step 1)
- Create: `scripts/recipe_closure_check.py` (durable port of `/tmp/closure_check.py`)
- Create: `scripts/dump_recipe_graph.ts` (durable port of `/tmp/dump_graph.ts`)

**Interfaces:**
- Produces: `python3 scripts/bootstrap_test.py` → faithful bootstrap sim; success line `>>> Full target build placed in: <t>  (<n> buildings, …)`; failure line `!! BLOCKED @ <t> — every ready target deferred. still needed: {…}`.
- Produces: `npx tsx scripts/dump_recipe_graph.ts > /tmp/graph.json` → `{recipes:{bld:{in:[],out:[]}}, placement:{bld:[res]}, meta:{res:terminal}}`.
- Produces: `python3 scripts/recipe_closure_check.py` → per-orphan recipe-input closure + per-proposed-consumer `safe`/`CYCLE via […]` verdict.

- [ ] **Step 1: Reset the planner copy to a known-clean state**

The Phase-1 prototype already added 6 byproduct loops to `scripts/bootstrap_test.py`. Keep that file as the P4 working planner. Confirm it still runs clean:

Run: `cd /root/robot-islands && timeout 590 python3 -u scripts/bootstrap_test.py | grep -E "BLOCKED|Full target build placed"`
Expected: `>>> Full target build placed in: <t>  (258 buildings, …)` — NO `BLOCKED`.

- [ ] **Step 2: Port the closure tooling into `scripts/`**

Copy `/tmp/dump_graph.ts` → `scripts/dump_recipe_graph.ts` and `/tmp/closure_check.py` → `scripts/recipe_closure_check.py` (already authored and verified during analysis). Fix the import paths in the `.ts` to relative (`../src/recipes.ts`, `../src/building-defs.ts`) so it runs from repo root.

- [ ] **Step 3: Verify the closure screen runs**

Run: `cd /root/robot-islands && npx tsx scripts/dump_recipe_graph.ts > /tmp/graph.json && python3 scripts/recipe_closure_check.py | grep -cE "CYCLE"`
Expected: `0` (no proposed consumer creates a recipe-input cycle).

- [ ] **Step 4: Capture the green baseline of the real suites**

Run: `cd /root/robot-islands && npx vitest run --project client src/recipes.test.ts src/mass-balance.test.ts src/economy.test.ts`
Expected: PASS (record counts; this is the pre-P4 baseline).

- [ ] **Step 5: Commit the tooling**

```bash
cd /root/robot-islands && git checkout -b p4-resource-graph-closure
git add scripts/dump_recipe_graph.ts scripts/recipe_closure_check.py scripts/bootstrap_test.py
git commit -m "chore(p4): durable deadlock-validation tooling (planner copy + closure screen)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 0 — Tag-only fixes (7 orphans, already consumed in `src`)

These resources already have a sink shipped today; only the `RESOURCE_META.terminal` tag is wrong. Zero new content, zero deadlock risk. 40 → 33.

### Task 1: Retag the 7 already-consumed orphans

**Files:**
- Modify: `src/recipes.ts` (`RESOURCE_META`, the 7 entries)
- Test: `src/recipes.test.ts` (existing terminal-consistency + new explicit assertions)

**Interfaces:**
- Consumes: existing consumers — `heavy_oil` → recipe inputs of `chemical_reactor`/`lubricant_refinery`/`diesel_refinery`; the other 6 → `placementCost` of shipped buildings (verified via `scripts/recipe_closure_check.py` consumer scan).
- Produces: orphan ledger drops by 7.

- [ ] **Step 1: Write the failing assertions**

Add to `src/recipes.test.ts` in the terminal-classification describe block:

```ts
it('P4 Phase-0: already-consumed orphans are correctly tagged', () => {
  // recipe-input consumer → 'consumed'
  expect(RESOURCE_META.heavy_oil.terminal).toBe('consumed');
  // non-recipe (placement-cost) consumer → 'gameplay-sink'
  for (const r of [
    'antimatter_propellant', 'plasma_charge', 'ceramic_insulator',
    'heavy_cable', 'glass_panel', 'saltwater_cell',
  ] as ResourceId[]) {
    expect(RESOURCE_META[r].terminal, r).toBe('gameplay-sink');
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run -t "P4 Phase-0" src/recipes.test.ts`
Expected: FAIL (all 7 still `expansion-hook:…`).

- [ ] **Step 3: Retag the 7 entries in `RESOURCE_META`**

In `src/recipes.ts`, change the `terminal` field (leave `massPerUnitKg` untouched):

```ts
heavy_oil:             { massPerUnitKg: 1, volumePerUnitL: 1, terminal: 'consumed' },
antimatter_propellant: { /* …existing mass… */ terminal: 'gameplay-sink' },
plasma_charge:         { /* …existing mass… */ terminal: 'gameplay-sink' },
ceramic_insulator:     { /* …existing mass… */ terminal: 'gameplay-sink' },
heavy_cable:           { /* …existing mass… */ terminal: 'gameplay-sink' },
glass_panel:           { /* …existing mass… */ terminal: 'gameplay-sink' },
saltwater_cell:        { /* …existing mass… */ terminal: 'gameplay-sink' },
```

(Preserve each line's existing `massPerUnitKg`/`volumePerUnitL`; only the `terminal` value changes.)

- [ ] **Step 4: Run the gate tests**

Run: `npx vitest run src/recipes.test.ts src/mass-balance.test.ts`
Expected: PASS (`heavy_oil` now `consumed` has its 3 recipe consumers; the other 6 are `gameplay-sink`, not gate-checked).

- [ ] **Step 5: Verify the ledger dropped**

Run: `grep -cE "terminal: '?\`?expansion-hook" src/recipes.ts`
Expected: `33`.

- [ ] **Step 6: Update SPEC §7 + commit**

In `SPEC.md:774` closure note, add a P4 Phase-0 sentence: the 7 already-consumed resources retagged (`heavy_oil → consumed`; `antimatter_propellant`, `plasma_charge`, `ceramic_insulator`, `heavy_cable`, `glass_panel`, `saltwater_cell` → `gameplay-sink` via placement cost).

```bash
git add src/recipes.ts src/recipes.test.ts SPEC.md
git commit -m "feat(p4): close 7 already-consumed orphans by retag (40→33)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 — Byproduct loops (8 orphans, planner-validated)

**DESIGN DECISION (option A, approved 2026-06-20):** A byproduct gas is a *side* output of a building whose *primary* output is valuable (smelter→iron_ingot, steel_mill→steel, the mills→beam/pipe/wire). It currently sits in `NON_STORED_OUTPUTS` (never stored → never stalls the producer, but **not drawable** → can't be a recipe input). Simply removing it from that set makes it a normal capped bin, and since its producers have **no `forceRun`** — and *can't* (building-level `forceRun`/`ignoreOutputCap` would also void the valuable primary output) — a full byproduct bin would re-gate the producer (the §2.6 throttle regression). So Phase 1 first adds a **per-output cap-exemption** mechanism: a designated `(building→output)` resource is stored up to cap, **drawable**, but excluded from the producer's cap-stall/solver constraints so a full bin never throttles it; overflow above cap voids (the integrator already clamps to cap). The 6 byproducts move from `NON_STORED_OUTPUTS` into this exemption, then gain consumer recipes and tag `'consumed'`. Deadlock-freedom of the loops is already proven in `scripts/bootstrap_test.py`. Run the planner once after the whole phase.

> Recipe balance: most resources are `massPerUnitKg: 1`. The mass-balance gate accepts a `±5%·inputMass + 0.5 kg` band for recipes carrying an `exogenousFlow` tag (e.g. `blast_furnace`), exact (<0.001) otherwise. A recipe-input add must keep the host recipe inside its band — for `co`→`blast_furnace`, add `co` as a reductant **replacing an equal mass of `coke`** (real chemistry: CO is the reducing agent) so input mass is unchanged.

### Task 2: Per-output cap-exemption mechanism (FOUNDATION — do first)

**Files:**
- Modify: `src/economy.ts` (new `OUTPUT_CAP_EXEMPT` set keyed by `(BuildingDefId, ResourceId)` or a helper; `outputAvail()` skips the cap check for an exempt output; the §15.3 solver's `capConstrained` set / `_flow_specs` excludes exempt outputs — mirror the existing per-building `ignoreOutputCap` path, scoped per-output). Migrate the 6 current byproducts (`co`, `refinery_gas`, `wood_tar`, `water_vapor`, `cryo_coolant_vented`, `mill_scale`) OUT of `NON_STORED_OUTPUTS` and INTO the exemption (so they are now stored+drawable+non-stalling instead of vented). `co2` STAYS in `NON_STORED_OUTPUTS` (it is the global atmosphere scalar — do NOT move it).
- Modify: `src/economy.test.ts` (the §2.6 byproduct-throttle guard: the 6 byproducts must NOT stall their producers when their bin is full, AND must now be readable from inventory — add an assertion that a full exempt-output bin leaves the producer's primary output running at full rate and the byproduct stock pinned at cap, not 0).
- Modify: `SPEC.md` §2.6 / §15.3 note (document the per-output cap-exemption as the byproduct mechanism replacing whole-class venting).
- Test: `src/economy.test.ts`, `src/mass-balance.test.ts`, `src/recipes.test.ts`.

**Interfaces:**
- Produces: `OUTPUT_CAP_EXEMPT` (or equivalent) — later loop tasks reference it instead of `NON_STORED_OUTPUTS`. After this task the 6 byproducts are stored, drawable, non-stalling, with no consumer yet (still `expansion-hook` — ledger unchanged at 33).

This task is the foundational economy change — route to an **opus implementer with deviate-and-report authority** (cross-cutting integrator change; the implementer is the first independent check on the mechanism). TDD: write the throttle/drawable guard test first (RED), implement the per-output exemption, GREEN, commit. Do NOT retag any resource `'consumed'` here (no consumer yet) — that is the loop tasks.

### Task 3: `co` → blast-furnace reductant (recipe-input add)

**Files:** `src/recipes.ts` (`RECIPES.blast_furnace` inputs; `RESOURCE_META.co`), `src/recipes.test.ts`, `src/mass-balance.test.ts`.

- [ ] **Step 1: Failing test** — assert `co` has a recipe consumer and is `consumed`:

```ts
it('P4: co has a recipe consumer and is consumed', () => {
  const consumers = Object.values(RECIPES).filter(r => r && 'co' in r.inputs);
  expect(consumers.length).toBeGreaterThan(0);
  expect(RESOURCE_META.co.terminal).toBe('consumed');
});
```

- [ ] **Step 2: Verify it fails.**
- [ ] **Step 3: Edit `RECIPES.blast_furnace.inputs`** from `{ iron_ore: 35, coke: 18, limestone: 10 }` to `{ iron_ore: 35, coke: 15, co: 3, limestone: 10 }` (co replaces 3 kg of coke; input mass stays 63, Δ unchanged at 2 ≤ exogenous band 3.65 — verify against `mass-balance.test.ts`). Retag `RESOURCE_META.co.terminal = 'consumed'`. (`co` is already in `OUTPUT_CAP_EXEMPT` from Task 2, so smelter/steel_mill do not stall.)
- [ ] **Step 4: Gates** — `npx vitest run src/recipes.test.ts src/mass-balance.test.ts src/economy.test.ts` → PASS.
- [ ] **Step 5: Commit** (`feat(p4): close co — blast-furnace reductant` + Kimi trailer).

### Task 4: `refinery_gas` → plastic-precursor co-feed (recipe-input add)

Add `refinery_gas` to `RECIPES.plastic_polymerizer_a.inputs` (acyclic producer: `naphtha_cracker`), re-balance the recipe to its band, retag `consumed`. (`refinery_gas` already in `OUTPUT_CAP_EXEMPT`.) Tests + commit.

> NOTE for the loop tasks below: the `NON_STORED_OUTPUTS`→`OUTPUT_CAP_EXEMPT` migration and the no-stall guarantee are done once in Task 2 — ignore any "remove from `NON_STORED_OUTPUTS`" or "producers already `forceRun`" phrasing here; each loop task only adds its consumer recipe (+ building) and retags `'consumed'`.

### Task 5: `wood_tar` + `tar` → asphalt (new `tar_refinery` building)

**Files:** `src/recipes.ts` (new `RECIPES.tar_refinery`, `RecipeId` union, `RESOURCE_META.wood_tar`/`tar`), `src/building-defs.ts` (new `tar_refinery` def + `BuildingDefId`), `src/building-defs.test.ts` (`KNOWN_DEF_IDS`), `src/recipe-density.ts` (`BUILDING_ARCHETYPE.tar_refinery`), `src/economy.ts` (remove `'wood_tar'` from `NON_STORED_OUTPUTS`).

- [ ] **Step 1: Failing test** — `tar_refinery` exists, consumes `wood_tar` + `tar`, both `consumed`:

```ts
it('P4: tar_refinery consumes wood_tar and tar', () => {
  const r = RECIPES.tar_refinery;
  expect(r && 'wood_tar' in r.inputs && 'tar' in r.inputs).toBe(true);
  expect(RESOURCE_META.wood_tar.terminal).toBe('consumed');
  expect(RESOURCE_META.tar.terminal).toBe('consumed');
});
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Add the recipe** `tar_refinery: { inputs: { wood_tar: 1, tar: 1 }, outputs: { asphalt: 2 } }` (unit-mass balanced) + building def (T2 chemistry, `forceRun` not needed — it is a consumer) + `KNOWN_DEF_IDS` + `BUILDING_ARCHETYPE`.
- [ ] **Step 4:** Remove `'wood_tar'` from `NON_STORED_OUTPUTS`; retag `wood_tar`, `tar` → `consumed`; update §2.6 guard (drop `wood_tar`).
- [ ] **Step 5:** Sink `asphalt` — add `asphalt` to a T3 placement cost (`platform_constructor`, off the producer critical path) and retag `RESOURCE_META.asphalt.terminal = 'gameplay-sink'`. (asphalt is produced by `crude_oil_cracker` + `tar_refinery`; placement-cost sink, planner-validated.)
- [ ] **Step 6: Gates** + `building-defs.test.ts` + commit.

### Task 6: `water_vapor` → fresh_water (new `vapor_condenser` building)

New `vapor_condenser` (T1 chemistry): `{ inputs: { water_vapor: 1 }, outputs: { fresh_water: 1 } }`. Producers `brick_kiln`/`charcoal_kiln` already `forceRun`. Remove `'water_vapor'` from `NON_STORED_OUTPUTS`; retag `consumed`; full building wiring (`KNOWN_DEF_IDS`, `BUILDING_ARCHETYPE`); update §2.6 guard. Tests + commit.

### Task 7: `cryo_coolant_vented` → cryo_coolant (new `cryo_reliquefier` building)

New `cryo_reliquefier` (T3 chemistry): `{ inputs: { cryo_coolant_vented: 1 }, outputs: { cryo_coolant: 1 } }`. Acyclic primary source of `cryo_coolant` is `cryo_lab` (independent); reliquefier is recovery. Remove `'cryo_coolant_vented'` from `NON_STORED_OUTPUTS`; retag `consumed`; building wiring; §2.6 guard. Tests + commit.

### Task 8: `mill_scale` → iron_ore sinter (new `mill_scale_sinter` building)

New `mill_scale_sinter` (T2 smelting): `{ inputs: { mill_scale: 2 }, outputs: { iron_ore: 1 } }` — re-balance to unit mass (2 in = 2 out: pick `outputs: { iron_ore: 2 }` if 1:1 mass). Producers (the mills) already `forceRun`. Remove `'mill_scale'` from `NON_STORED_OUTPUTS`; retag `consumed`; building wiring; §2.6 guard. Tests + commit.

### Task 9: Phase-1 deadlock + suite gate

- [ ] **Step 1: Run the faithful planner** — `cd /root/robot-islands && timeout 590 python3 -u scripts/bootstrap_test.py | grep -E "BLOCKED|Full target build placed"` → MUST print `Full target build placed`, never `BLOCKED`.
- [ ] **Step 2: Full client suite** — `npx vitest run --project client` → PASS.
- [ ] **Step 3: Typecheck** — `npx tsc -b` → exit 0.
- [ ] **Step 4: Ledger** — `grep -cE "terminal: '?\`?expansion-hook" src/recipes.ts` → `25`.
- [ ] **Step 5: SPEC §7 P4 byproduct-loop sentence + commit.**

---

## Phase 2 — Ocean concentrates (9 orphans, leaf refines)

All refine a concentrate into a product that already has demand (`helium_3`, `lithium`, `manganese_ingot`, `rare_earth`, `sulfur`, `natural_gas→hydrogen`). 6 are `RC=0` raws (trivially safe); the rest are leaf refines. Each gets a new refine recipe on its existing ocean processor via `resolveRecipe` rotation OR a dedicated downstream refiner. Validate each with the closure screen (Step pattern below); these are NOT in the bootstrap target set, so no planner run.

> Per-orphan refine targets (from design §6 + the `expansion-hook:` tag hints): `he3_dilute`→`helium_3`; `tritium_seed`→`tritium`/fusion-fuel input; `lithium_brine`→`lithium`; `rare_earth_concentrate`→`rare_earth`; `refined_cobalt`→ battery-cathode/magnetic_alloy input; `mn_nodule`→`manganese_ingot`; `vent_sulfide`→`sulfur`(+ base-metal ore); `methane_hydrate`→`natural_gas`; `natural_gas`→`hydrogen` (steam-methane reforming).

### Task 9 (template task — repeat per concentrate): close one ocean concentrate

**Files:** `src/recipes.ts` (new refine recipe + `RecipeId` if new host; `RESOURCE_META.<orphan>` → `consumed`), host building (existing refiner via `resolveRecipe`, else new def with full wiring), `src/recipe-density.ts` if new building.

**Interfaces:**
- Consumes: `<concentrate>` from its ocean rig (verified producer in `/tmp/graph.json`).
- Produces: existing demanded product; `<concentrate>` becomes `consumed`.

- [ ] **Step 1: Failing test** — assert the concentrate has a recipe consumer and is `consumed`:

```ts
it('P4: <concentrate> refines into <product> and is consumed', () => {
  const consumers = Object.values(RECIPES).filter(r => r && '<concentrate>' in r.inputs);
  expect(consumers.length).toBeGreaterThan(0);
  expect(RESOURCE_META.<concentrate>.terminal).toBe('consumed');
});
```

- [ ] **Step 2: Verify fail.**
- [ ] **Step 3: Add the refine recipe** `{ inputs: { <concentrate>: N }, outputs: { <product>: M } }` balanced via `massPerUnitKg` (check non-unit masses for `helium_3`/`tritium`/`lithium`). If the chemistry is genuinely fantasy (fusion-seed transmutation), add the `RecipeId` to `RECIPE_SPECULATIVE` with `'fantasy chemistry'` instead of forcing a balance. Host on the existing ocean refiner via `resolveRecipe` rotation where one exists (minimize new buildings); else add a dedicated refiner with full wiring.
- [ ] **Step 4: If a new product resource is introduced**, add `ResourceId`, `ALL_RESOURCES`, `RESOURCE_META` (with `XP_WEIGHT` matching the producer tier), and `RESOURCE_STORAGE_CATEGORY`.
- [ ] **Step 5: Closure screen** — `npx tsx scripts/dump_recipe_graph.ts > /tmp/graph.json && python3 scripts/recipe_closure_check.py | grep "<concentrate>"` → verify `safe` (no `CYCLE`); if flagged, confirm an acyclic producer exists / the consumer is off the rig's critical path.
- [ ] **Step 6: Gates** (`recipes.test.ts`, `mass-balance.test.ts`) + commit per concentrate (or batch the 9 into 2–3 commits by sub-family: fusion fuels, metals, gas).

> Apply Task 9 to: `he3_dilute`, `tritium_seed`, `lithium_brine`, `rare_earth_concentrate`, `refined_cobalt`, `mn_nodule`, `vent_sulfide`, `methane_hydrate`, `natural_gas`. After all 9: `grep -cE "terminal: '?\`?expansion-hook" src/recipes.ts` → `16`. Full client suite + `tsc -b` green. SPEC §7 P4 ocean sentence.

---

## Phase 3 — Mid-tier alloy / chemistry / build tails (16 orphans, leaf adds)

All closure-screened `safe`. Group by mechanism. Each chain-introducing task ends with the closure screen; recipe-input adds re-balance the host recipe.

### Task 10: Recipe-input adds (consume orphan into an existing downstream recipe)

Per design §7–§9 + tag hints. For each, add the orphan to an existing recipe's `inputs`, re-balance that recipe, retag `consumed`, closure-screen, gate, commit (batch by family):

- `charcoal` → biogenic reductant in `smelter`/`silicon_crusher`/`carbon_forge` (closure: `safe`).
- `tool_steel` → drill-bit/die input in `metal_rolling_mill`/`bearing_assembler` (`safe`).
- `bronze` → bushings in `bearing_assembler` (`safe`).
- `brass` → fittings/terminals in `hydraulic_assembly`/`pneumatic_assembly`/`cable_mill`/`motor_assembly` (`safe`).
- `hydrochloric_acid` → pickling in `metal_rolling_mill`/`pipe_mill`/`silicon_crusher` (`safe`).
- `bromine` → flame-retardant in `pcb_etcher` (`safe`).
- `phosphor` → display/lamp component in `lithography_lab`/`pcb_etcher` (`safe`).
- `memory_module` → RAM input in `cryogenic_compute_center` (ai_core) (`safe`).
- `sheet_metal` → enclosures in `kit_assembler`/`circuit_assembler` (+ HVAC/cooling_tower placement) (`safe`).
- `slaked_lime` → mortar binder in `mortar_mixer` (`safe`).
- `synthetic_rubber` → seals in `hydraulic_assembly`/`pneumatic_assembly`/`cable_mill` (`safe`).

Each: failing test (orphan consumed) → add input + re-balance → retag → closure screen `safe` → gates → commit.

### Task 11: New refine recipe — amalgamation (`gold_ore` + `silver_ore` + `mercury`)

**Files:** `src/recipes.ts` (new `amalgamator` recipe + host; `RESOURCE_META` for the 3; new product resources `refined_gold`/`refined_silver` if introduced), building wiring.

- [ ] One amalgamation recipe consuming `gold_ore` + `silver_ore` + `mercury` → refined gold/silver (→ microchip contacts / solar paste demand). Mass-balance via `massPerUnitKg` (mercury is heavy — check its mass). Closure-screen all three `safe`. Retag the 3 → `consumed`. Tests + commit.

### Task 12: Placement-cost adds (`galvanized_steel`, `mortar`)

- `galvanized_steel` → placement cost of T2+ ocean/coastal buildings (`sonar_buoy`, ocean extractors) — NOT early T1 buildings (bootstrap-order safety). Retag `gameplay-sink`.
- `mortar` → masonry placement baskets (resilience-line T2 buildings). Retag `gameplay-sink`.

- [ ] Failing test (both `gameplay-sink`) → add placement costs → retag → planner run (placement costs affect affordability/order) `Full target build placed` → gates → commit.

### Task 13: Phase-3 gate

- [ ] Closure screen `grep -cE CYCLE` → `0`; planner `Full target build placed`; full client suite + `tsc -b` green; `grep -cE "terminal: '?\`?expansion-hook" src/recipes.ts` → `0`. SPEC §7 P4 mid-tier sentence.

---

## Phase 4 — Final sweep & integration

### Task 14: Whole-suite verification, SPEC + status doc, integrate

**Files:** `SPEC.md` (§7 closure note — mark P4 complete, orphan ledger 0), `docs/reports/2026-06-19-resource-graph-closure-status.md` (status → closed).

- [ ] **Step 1: Orphan ledger is 0** — `grep -cE "terminal: '?\`?expansion-hook" src/recipes.ts` → `0`.
- [ ] **Step 2: Full client suite** — `npx vitest run --project client` → PASS.
- [ ] **Step 3: Server suite** — `cd server && npm test` → PASS (unaffected; confirm no regression).
- [ ] **Step 4: Typechecks** — `npx tsc -b` (root) + `cd server && npx tsc --noEmit` → exit 0.
- [ ] **Step 5: Final planner run** — `timeout 590 python3 -u scripts/bootstrap_test.py | grep -E "BLOCKED|Full target build placed"` → `Full target build placed`.
- [ ] **Step 6: SPEC §7 + status doc** — record P4 complete, the per-orphan sink table, ledger 0; note the byproduct loops removed from `NON_STORED_OUTPUTS` and the §2.6 guard now covering only `co2`.
- [ ] **Step 7: Rebase + fast-forward to master** — `git rebase master && git checkout master && git merge --ff-only p4-resource-graph-closure`; confirm `master` green.

---

## Self-Review notes

- **Spec coverage:** all 40 orphans mapped to a task — Phase 0 (7 tag-fix), Phase 1 (8 byproduct), Phase 2 (9 ocean), Phase 3 (16 mid-tier). 7+8+9+16 = 40. ✓
- **Deadlock coverage:** byproduct loops → planner (multi-producer-correct); ocean + mid-tier → closure screen; placement-cost adds → planner (ordering). ✓
- **Gate coverage:** every `'consumed'` retag is preceded by authoring a recipe input consumer (recipes.test.ts gate) and a mass-balanced recipe (mass-balance.test.ts) or `RECIPE_SPECULATIVE`. ✓
- **Known balance hazards:** non-unit `massPerUnitKg` resources (mercury, helium_3, the heavy/fantasy fuels) — re-check balance when they appear in inputs/outputs; prefer real coefficients, fall back to `RECIPE_SPECULATIVE` only for genuine fantasy chemistry.
- **Type consistency:** new `RecipeId`/`BuildingDefId`/`ResourceId` union members must be added before use; each new building touches `KNOWN_DEF_IDS`, `BUILDING_ARCHETYPE`, and (new resource) `ALL_RESOURCES`/`RESOURCE_STORAGE_CATEGORY`/`XP_WEIGHT`.
