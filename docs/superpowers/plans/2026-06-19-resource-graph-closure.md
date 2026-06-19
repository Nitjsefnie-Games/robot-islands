# Resource-graph closure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the resource graph — give every produced-but-unconsumed resource a real sink — while keeping the mass-balance auditor and the `terminal`-consistency test green.

**Architecture:** Closing an orphan means adding a real consumer and flipping its `RESOURCE_META[r].terminal` tag. Two closure mechanics, picked per orphan by risk:
- **Recipe consumer** → tag `'consumed'`. The new/edited recipe must pass `mass-balance.test.ts` (Σ input kg = Σ output kg via `massPerUnitKg`). Gated by `recipes.test.ts:156` ("tagged-'consumed' produced resources have ≥1 recipe consumer").
- **Non-recipe consumer** (placement cost, fuel ladder, etc.) → tag `'gameplay-sink'`. Not checked by the recipe-consumer test and not subject to the mass-balance auditor.

**Tech Stack:** TypeScript strict, vitest. Pure-layer edits in `src/recipes.ts`, `src/building-defs.ts`, `src/economy.ts`. No new deps.

## Global Constraints

- Every behavior change updates `SPEC.md` in the same change (AGENTS.md).
- New code compiles clean under `strict` + `noUncheckedIndexedAccess` + `noUnusedLocals`/`noUnusedParameters`.
- `npx vitest run --project client` and `npx tsc -b` stay green after every task.
- Closure gate tests: `src/recipes.test.ts` (terminal consistency) and `src/mass-balance.test.ts` (Σin = Σout).
- The `terminal` field type is exactly `'consumed' | 'gameplay-sink' | \`expansion-hook:${string}\`` (`recipes.ts:1082`).
- Buildings host exactly one recipe (`resolveRecipe`); a new refine recipe needs a host building or a `resolveRecipe` variant.
- `placementCost` is `Partial<Record<ResourceId, number>>` on a building def (`building-defs.ts:590`).

---

## Wave structure (the whole closure, phased by risk)

| Phase | Scope | Risk | This plan |
|---|---|---|---|
| **P0** | Byproduct-gas throttle: verify it's real, fix if so | correctness | **Detailed + implement now** |
| **P1** | Tag hygiene — re-tag mis-tagged orphans (already have a sink) | none | **Detailed + implement now** |
| **P2** | Endgame-component placement closures (bootstrap-safe subset of design §11) | low | **Detailed + implement now** |
| **P3** | Early-machine placement baskets (design §10) + T5-raw inputs (§12) | balance/bootstrap | Backlog (per-item balance review) |
| **P4** | Refine-recipe closures: ocean §6 / alloy §7 / chemistry §8 / build-material §9 / byproduct loops §4 | recipe authoring + new buildings | Backlog (per-orphan stoichiometry + host building) |
| **P5** | `self_replication_module` free-floor tokens (§13) | new mechanic + §15 sign-off | Backlog (needs decision) |
| **P6** | CO₂ single global atmosphere (§2) | architecture, optional | Backlog (no longer a correctness fix) |

P0–P2 land green this pass. P3–P6 are captured below with their mappings; each needs a per-item design decision or balance review, so they are NOT step-detailed here (writing fabricated stoichiometry/placement blind to balance would break the gates).

---

## Phase 0 — Byproduct-gas throttle (verify, then fix)

The 2026-06-13 design §1.2 claimed a producer at a full byproduct-gas output bin self-throttles to net 0. `co2` was since removed from inventory, but `co`, `refinery_gas`, `wood_tar`, `water_vapor`, `cryo_coolant_vented`, `mill_scale` are still capped bins (`storage-categories.ts:382-391`) tagged `expansion-hook`. We do NOT assert the throttle exists — a test discovers it.

### Task 0.1: Regression test — does a full byproduct bin stall its producer?

**Files:**
- Test: `src/economy.test.ts` (new `describe`)

**Interfaces:**
- Consumes: `advanceIsland(state, nowMs)` from `economy.ts`; `makeIslandState`/island builders already in `economy.test.ts`.
- Produces: nothing (diagnostic test).

- [ ] **Step 1: Pick a real emitter+byproduct pair.** Inspect `RECIPES` for a building whose recipe outputs `co` (e.g. `blast_furnace`/`smelter`) with all OTHER inputs/outputs satisfiable. Confirm `co` has no recipe consumer and is `liquid_gas` capped.

- [ ] **Step 2: Write the failing-or-passing diagnostic test.** Build an island with that emitter, full input stock, and the `co` bin pre-filled to cap. Advance a long segment (e.g. 6 h). Assert the emitter still produced its PRIMARY output (i.e. did NOT stall on the full `co` bin):

```ts
// pre-fill co to cap, advance 6h, assert primary output still accrued
const before = inv(state, 'steel'); // or the emitter's real primary output
advanceIsland(state, sixHoursMs);
expect(inv(state, 'steel')).toBeGreaterThan(before); // FAILS if co bin stalls the building
```

- [ ] **Step 3: Run it.** `npx vitest run src/economy.test.ts -t "byproduct"`.
  - **If it PASSES:** the throttle is NOT real (the §15.3 solver or an existing exclusion handles it). Mark P0 complete; keep the test as a guard; skip 0.2. Note the finding in SPEC §2.6.
  - **If it FAILS:** the throttle is real → proceed to Task 0.2.

- [ ] **Step 4: Commit** (the guard test, regardless of outcome).

```bash
git add src/economy.test.ts && git commit -m "test(economy): guard against byproduct-gas full-bin producer stall (§2.6)"
```

### Task 0.2 (only if 0.1 fails): Vent the byproduct gases

**Files:**
- Modify: `src/economy.ts` (output-application path), mirroring the `co2` exclusion.
- Modify: `SPEC.md` §2.6.

- [ ] **Step 1:** Find the exact path that excludes `co2` from the inventory net (search `economy.ts`/`flow-solver.ts` for the co2 special-case the climate-scalar loop relies on). Define a `VENTED_BYPRODUCTS` set `{co, refinery_gas, wood_tar, water_vapor, cryo_coolant_vented}` (gases) and extend that exclusion to them so they never occupy a capped bin (`mill_scale` is a solid — handle in P4 as a recycle recipe instead, or vent if 0.1 shows it stalls).
- [ ] **Step 2:** Re-run Task 0.1's test → now PASS. Run full `economy.test.ts`.
- [ ] **Step 3:** Update `SPEC.md` §2.6: vented byproduct gases bypass inventory (no sink, no stall) pending real consumer loops (P4 §4).
- [ ] **Step 4: Commit.**

---

## Phase 1 — Tag hygiene (honest ledger, zero gameplay change)

Three `expansion-hook` resources already HAVE a non-recipe sink and are mis-tagged, inflating the orphan count. Re-tag to `gameplay-sink` (consumed by a non-recipe system). No gameplay change; `recipes.test.ts:156` only constrains `'consumed'`, so `gameplay-sink` is safe.

**Files:** Modify `src/recipes.ts` (`RESOURCE_META` entries); Test: `src/recipes.test.ts`.

- [ ] **Step 1: Verify each claimed sink exists.**
  - `biofuel`, `aviation_kerosene`: consumed by `fuelForTier` (drone/vehicle fuel ladder). Confirm via `grep -n "fuelForTier\|FUEL_FOR_TIER" src/recipes.ts` and the ladder table.
  - `air`: an atmospheric SOURCE (`exogenousFlow === 'atmosphere'`), not a stored product. Confirm it's drawn from atmosphere, not inventory.
- [ ] **Step 2: Write/extend a test** asserting these three are NOT `expansion-hook`:

```ts
it('fuel-ladder fuels + atmospheric air are gameplay-sinks, not orphans', () => {
  for (const r of ['biofuel', 'aviation_kerosene', 'air'] as ResourceId[]) {
    expect(RESOURCE_META[r].terminal).toBe('gameplay-sink');
  }
});
```

- [ ] **Step 3: Run → FAIL** (they're currently `expansion-hook`).
- [ ] **Step 4: Re-tag** the three `RESOURCE_META` entries to `terminal: 'gameplay-sink'`.
- [ ] **Step 5: Run → PASS**, plus full `recipes.test.ts` (terminal-consistency still green).
- [ ] **Step 6: Commit.**

```bash
git add src/recipes.ts src/recipes.test.ts && git commit -m "fix(recipes): re-tag fuel-ladder fuels + air as gameplay-sink (ledger hygiene)"
```

> Also re-scan for `aviation_kerosene_crude` — if it feeds `aviation_kerosene` via a recipe it's already `consumed`; if it's only an intermediate, confirm its real consumer before deciding its tag.

---

## Phase 2 — Endgame-component placement closures (bootstrap-safe)

Design §11: late-game components that lead nowhere become the `placementCost` of the building they're named for / belong to. These are all **late-tier** (no early-bootstrap risk — the building and the component unlock together), so they are the safe placement-basket subset. Each: add the component to the target building's `placementCost`, then tag the component `gameplay-sink`.

**Mapping (verify each building id + that the component is craftable before/with the building during implementation):**

| Orphan | Placement-cost consumer (building) |
|---|---|
| `singularity_battery_unit` | `singularity_battery` |
| `particle_accelerator_core` | `particle_accelerator` |
| `cryo_containment_unit` | `cryogenic_compute_center` / `antimatter_refinery` |
| `singularity_sensor` | `orbital_tracking_station` / scanner chain |
| `probability_calculator` | `probability_engine` |
| `aether_beacon` | `lighthouse_t6` / relay chain |
| `reality_engine` | `universe_editor` / `genesis_forge` |
| `antimatter_propellant` | `antimatter_refinery` consumer / launch chain |
| `plasma_charge` | `plasma_containment_assembler` / mass-driver charge building |

**Per-orphan task pattern (repeat for each row):**

- [ ] **Step A: Confirm the building id exists** in `BUILDING_DEFS` and is the same/later tier as the component's producer (no bootstrap inversion). If the named building doesn't exist, pick the nearest late-tier consumer from the design's alternatives; if none, defer that row to P4.
- [ ] **Step B: Write the failing test** (`building-defs.test.ts` or `recipes.test.ts`):

```ts
it('<building> placement cost consumes <component>', () => {
  expect(BUILDING_DEFS['<building>'].placementCost?.['<component>'] ?? 0).toBeGreaterThan(0);
});
it('<component> is no longer an orphan', () => {
  expect(RESOURCE_META['<component>'].terminal).toBe('gameplay-sink');
});
```

- [ ] **Step C: Run → FAIL.**
- [ ] **Step D: Implement** — add `<component>: N` to the building's `placementCost` (N small, 1–4, since these are precious endgame parts), and set `RESOURCE_META['<component>'].terminal = 'gameplay-sink'`.
- [ ] **Step E: Run → PASS**, plus full `recipes.test.ts` + `building-defs.test.ts` + `tsc -b`.
- [ ] **Step F: Commit** (batch 2–3 rows per commit is fine; each row is independently testable).

- [ ] **Final P2 step: Update `SPEC.md`** §11 (or the catalog) noting each endgame component is now consumed by its building's placement cost.

---

## Phase 3 — Early-machine placement baskets + T5 raws (BACKLOG — balance review)

Design §10/§12. Same placement-cost mechanic as P2, but the consumers are **early/mid-tier** buildings (`generator`→`coal_gen`/`biomass_plant`/…; `pump`→`coastal_pump`/`well`/…; `hydraulic_actuator`/`pneumatic_actuator`→presses/assemblers; `solar_cell`→`solar`/`sunspire`), and T5 raws (`quantum_foam`, `higgs_flux`, `neutronium`) route as recipe inputs into endgame component recipes.

**Why backlog, not now:** adding a manufactured component to an EARLY building's placement cost can soft-lock the bootstrap (you need the building to make power, but now need a manufactured part to build it). Each row needs a reachability/bootstrap check (the `bootstrap_planner_v3.py` tool + the `reachability.test.ts` infra) and possibly a small starter-kit grant. The T5-raw recipe-input adds also unbalance their host recipes → need mass re-balancing. **Mapping is design §10/§12; do per-item with a balance gate.**

---

## Phase 4 — Refine-recipe closures (BACKLOG — stoichiometry + host buildings)

Design §4 (byproduct loops), §6 (ocean), §7 (alloy/coating), §8 (chemistry), §9 (build-material tails). ~30 orphans. Each needs: a balanced refine/consumer recipe (Σin kg = Σout kg) AND a host building (1:1 recipe-per-building) or a `resolveRecipe` variant on an existing under-used building. The orphan→sink mapping is the design's §4–§9 tables (still accurate against the current ledger §2 of the status doc). **Why backlog:** each recipe's stoichiometry + host-building choice is a per-orphan design decision; the §15 sign-offs (XP-weight inheritance, new-building-count ceiling) gate it. Implement as a sub-plan once §15 is signed off, one balanced recipe at a time, each green against the auditor.

---

## Phase 5 — self_replication_module free-floor tokens (BACKLOG — needs §15 sign-off)

Design §13. The one orphan with no natural recipe sink: spending one module waives the material cost of one §4.9 floor upgrade (build-time + module scarcity preserve the soft cap). Needs the §15 decision (any-floor vs exponential-band-only) before implementing `applyUpgrade` (placement.ts) + the inspector UI affordance + SPEC §4.9.

---

## Phase 6 — CO₂ single global atmosphere (BACKLOG — optional, not correctness)

Design §2. Now a non-correctness architectural refactor (the double-booking/throttle are already fixed). If revived: a **v26→v27** migration folding `Σ islandStates[*].co2Kg → WorldState.atmosphericCo2Kg`, retarget `sumIslandCo2`. Only worth doing if a future feature needs a single global counter. Decision #6 of the status doc: confirm it's still wanted.

---

## Self-review

- **Coverage:** every orphan group in the status-doc ledger §2 maps to a phase (P0 byproduct gases; P1 mis-tagged; P2 endgame components; P3 machines+T5 raws; P4 ocean/alloy/chemistry/build-material; P5 self-replication). ✅
- **Placeholders:** P0–P2 carry exact gates, code, and the closure mechanic. P3–P6 are explicitly BACKLOG with their design mappings, not fake-detailed steps (honest — their per-item stoichiometry/balance is real design work, not yet decided). ✅
- **Gate consistency:** every "add recipe consumer" → `'consumed'`; every "placement/non-recipe consumer" → `'gameplay-sink'`; matches `recipes.test.ts:156`. ✅

*Plan · 2026-06-19 · Robot Islands · resource-graph closure. Built on the 2026-06-19 status update + the 2026-06-13 design.*
