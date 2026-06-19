# Resource-graph closure — STATUS UPDATE (2026-06-19)

**Supersedes the planning content of** the 2026-06-13 design *"Closing the resource
graph: CO₂ atmosphere, byproduct-gas consumers, and 43 orphan sinks"*
(docs-hub slug `robot-islands/2026-06-13-resource-graph-closure-design`).

That design is now **outdated**: a *different* closure architecture shipped, the
schema versions it reserved were taken by other features, the orphan set grew, and
two of its three correctness goals were solved a simpler way. This doc records what
actually landed, the current orphan ledger, and what closing the graph now means.

---

## 0. TL;DR — design vs. reality

| Design proposed | What actually shipped | Verdict |
|---|---|---|
| **CO₂ as one global `WorldState.atmosphericCo2Kg`** (remove per-island `co2Kg`) | Per-island `state.co2Kg` scalar **retained**; `co2` was simply **removed from inventory** (only ever accrues to the climate scalar, `economy.ts:2400-2409`) | **Not done as specced** — but the *bugs* it targeted are fixed (below) |
| **Fix CO₂ double-booking** (co2 written to both inventory + scalar) | Fixed: `co2` is no longer written to inventory at all — no Path-A. Capture drains the scalar (`economy.ts:2442`) | ✅ **Resolved** (different mechanism) |
| **Fix byproduct-gas self-throttle** (capped bin → producer stalls) | Resolved **for `co2` only** (it bypasses inventory). The other six byproducts are still capped-bin orphans | ⚠️ **Partially resolved** |
| **Schema bump v24 → v25 for the CO₂ model** | `v24→v25` shipped **trade offers**; `v25→v26` shipped **route bending**. Current `SCHEMA_VERSION = 26`. The CO₂ migration never landed | **Schema drift** — re-target to v26→v27 if revived |
| **Close 43 orphan sinks** (Phase 2/3 recipe + placement mappings) | Almost none of the specific closures shipped. Instead orphans were **formalized** into a `RESOURCE_META.terminal` taxonomy + a **mass-balance auditor** test | **Tracked, not closed** |
| **`self_replication_module` → free-floor tokens** (§4.9 relief valve) | Not implemented. Still `terminal: 'expansion-hook:…'` (`recipes.ts:1244`) | ❌ **Not done** |
| **Orphan count: 43** | **62 `expansion-hook` resources** today (catalog kept growing; closures deferred) | Count **grew** |

**Bottom line:** the team built the *measurement and gating* infrastructure the
design asked for (decision #8 strict mass balance, an orphan ledger) but mostly
**deferred the actual closures**, recording each as an `expansion-hook`. The CO₂
correctness work was done the cheap way (co2 never enters inventory) instead of the
global-atmosphere refactor.

---

## 1. What actually landed (the new closure architecture)

Closing the graph is now organized around three runtime/test artifacts that did **not**
exist when the design was written:

1. **`RESOURCE_META` mass ledger** (`recipes.ts:1079+`). Every resource carries
   `{ massPerUnitKg, …, terminal }` where `terminal` is one of:
   - `'consumed'` — has a real recipe consumer (**135** resources).
   - `'gameplay-sink'` — consumed by a non-recipe system: skill crystals
     (`skilltree-crystals.ts`), satellites/repair (`orbital.ts`), the
     `fuelForTier` vehicle ladder, placement costs (**67** resources).
   - `` `expansion-hook:${reason}` `` — a **declared orphan**, deferred to future
     content with a one-line reason (**62** resources — the live backlog, §2).

   (The `terminal` field type has exactly these three values. `genesis_cell` — the
   design's one legitimately-terminal resource, no win state — is folded into one of
   them rather than being a distinct category.)

2. **Mass-balance auditor** (`mass-balance.test.ts`). Implements the design's
   locked **decision #8**: every recipe in `RECIPES` must mass-balance (Σ input kg =
   Σ output kg via `RESOURCE_META.massPerUnitKg`), with `RECIPE_SPECULATIVE` as the
   explicit escape hatch. This is now a green test gate — closing an orphan means
   adding a consumer recipe that **stays balanced**.

3. **Reachability invariant** (`reachability.test.ts`, rev-16 §12.9.5). Simulates
   the optimal build path from the starter inventory. Currently **`.todo`/BLOCKED**:
   the T2 steel buildings need ~25–30 t `steel_beam` (= 1.25–1.5 Mt actual mass),
   unreachable from the 1.8 t starter in 45 min. The named fix is the **Phase 7
   tutorial restructure**, not graph closure. The infra is in place; the test flips
   `.todo → .it` once the tutorial-side BOMs align.

4. **Bootstrap planner tool** (`scripts/bootstrap_planner_v3.py`, + v1/v2). An
   *offline analysis* tool (not runtime): computes the transitive closure of
   "feedable" buildings to a fixpoint (131/131), is byproduct-aware (force-run), and
   models the oil + downstream chemistry chain and `slag_reprocessor`. Useful for
   reasoning about reachability/closure; it does **not** itself change the in-game
   graph.

### CO₂ specifics (design §1–§3, as-built)

- `co2` recipe output accrues **only** to the per-island `state.co2Kg` climate
  scalar, and **only when non-biogenic** (`economy.ts:2404-2409`); biogenic CO₂
  (e.g. `charcoal_kiln`) is carbon-neutral and skipped.
- Fuel-combustion CO₂ enters via `exogenousFlow === 'fuel-combustion-CO₂'`
  (`economy.ts:2412-2420`) — the design's "exogenous" path, intact.
- Capture (`co2CaptureKgPerCycle`, with the `co2CaptureAdjacency` gate preserved)
  drains the scalar (`economy.ts:2426-2443`).
- `weather.ts sumIslandCo2()` still **sums per-island** values — the global counter
  the design reached for was never introduced. So the *climate model is unchanged*,
  and the double-booking/throttle are gone **because `co2` left inventory**, not
  because the atmosphere was unified.

**Implication:** the global-atmosphere refactor is now **optional/architectural**,
not a correctness fix. If revived it is a **v26 → v27** migration (fold
`Σ islandStates[*].co2Kg → atmosphericCo2Kg`), not v24 → v25.

---

## 2. Current orphan ledger — 62 `expansion-hook` resources

This is the live closure backlog, extracted from `RESOURCE_META` (`recipes.ts`).
Grouped to map onto the original design's sections. Most still carry the generic
`expansion-hook:Phase 2 supplies consumer` placeholder; a handful got a specific hook.

> **Caveat (over-count):** a few entries here *do* have a non-recipe sink and are
> arguably mis-tagged — notably `biofuel` and `aviation_kerosene` (consumed by the
> `fuelForTier` vehicle ladder, exactly the subtraction the design used to get 43→
> fewer) and `air` (an atmospheric source, not a product). The "true" orphan count
> is therefore **somewhat below 62**. Re-auditing the tags is itself a cheap closure
> task (§4).

### 2a. Byproduct gases / solids (design §1.2, §4 — the throttle class)
`co` · `co2`* · `refinery_gas` · `wood_tar` · `water_vapor` · `cryo_coolant_vented` · `mill_scale`

- *`co2` is throttle-safe (bypasses inventory). The **other six** are still
  `liquid_gas`/`dry_goods` capped bins (`storage-categories.ts:382-391`) with no
  consumer → **the §1.2 producer-stall is still a live risk** for `coke_oven`,
  `naphtha_cracker`, `charcoal_kiln`, the `*_mill` family, `cryogenic_generator`,
  etc. **Highest-priority remaining correctness item.**
- Specific hooks already annotated: `co` → "CO afterburn / oxidation chain",
  `refinery_gas` → "residential heating / petrochem feedstock", `wood_tar` →
  "creosote / wood-preservative chain", `water_vapor` → "condensing-loop / fresh-
  water reclamation", `cryo_coolant_vented` → "re-liquefaction loop", `mill_scale` →
  "scrap remelt / cement-kiln aggregate / brick pigment".

### 2b. Ocean concentrates (design §6)
`he3_dilute` · `tritium_seed` · `lithium_brine` · `rare_earth_concentrate` · `refined_cobalt` · `mn_nodule` · `vent_sulfide` · `methane_hydrate`

### 2c. Alloys, coatings & build-material tails (design §7, §9)
`galvanized_steel` · `tool_steel` · `bronze` · `brass` · `slaked_lime` · `mortar` · `charcoal` · `sheet_metal` · `heavy_cable` · `glass_panel` · `ceramic_insulator` · `synthetic_rubber` · `tar` · `asphalt` · `heavy_oil` · `saltwater_cell`

### 2d. Grounded chemistry (design §8)
`mercury` (→ "amalgamation chemistry / chlor-alkali Hg-cell variant") · `hydrochloric_acid` · `phosphor` · `memory_module` · `bromine` · `gold_ore` · `silver_ore`

### 2e. Petrochem / fuels (design §9) — *some mis-tagged, see caveat*
`natural_gas` (→ "ammonia / syngas / gas-turbine power") · `biofuel` · `aviation_kerosene` · `aviation_kerosene_crude`

### 2f. Phase-10 machines (design §10 — placement-basket closure)
`generator` · `pump` · `hydraulic_actuator` · `pneumatic_actuator` · `solar_cell`

### 2g. Endgame components (design §11 — eponymous buildings)
`singularity_battery_unit` · `particle_accelerator_core` · `singularity_sensor` · `cryo_containment_unit` · `probability_calculator` · `aether_beacon` · `reality_engine` · `antimatter_propellant` · `plasma_charge`

### 2h. Fantasy T5 raws (design §12 — route as inputs)
`quantum_foam` · `higgs_flux` · `neutronium`

### 2i. Self-replication (design §13)
`self_replication_module` — still terminal; the **free-floor-token** mechanic was not
built. (`air` also appears with the generic hook but is an atmospheric source, not a
product — ledger quirk.)

---

## 3. Phase-by-phase mapping (design → 2026-06-19 status)

| Design § | Item | Status |
|---|---|---|
| §1.1 | CO₂ double-booking | ✅ **Fixed** — co2 removed from inventory |
| §1.2 | Byproduct-gas throttle | ⚠️ **co2 fixed; 6 others still live** (2a) |
| §2 | CO₂ → single global atmosphere | ❌ **Not done** — per-island scalar retained (now optional) |
| §3 | CO₂ sinks (capture + feedstock chains) | ◐ Capture intact (`co2CaptureKgPerCycle`); **feedstock chains not built** |
| §4 | Byproduct consumers | ❌ **Not done** — all six remain `expansion-hook` |
| §5 | SPEC.md + persistence v24→v25 | ❌ **Superseded** — v24→v25/v25→v26 used by other features; re-target v26→v27 |
| §6 | Ocean refines | ❌ Not done (2b) |
| §7 | Alloy & coating mills | ❌ Not done (2c) |
| §8 | Grounded chemistry | ❌ Not done (2d) — `mercury` got a specific hook only |
| §9 | Build-material / petrochem tails | ❌ Not done (2c/2e) |
| §10 | Phase-10 machines → placement baskets | ❌ Not done (2f) |
| §11 | Endgame components → eponymous buildings | ❌ Not done (2g) |
| §12 | Fantasy T5 raws | ❌ Not done (2h) |
| §13 | `self_replication_module` free-floor tokens | ❌ Not done (2i) |
| §14 | Mass-balance auditor | ✅ **Landed** as `mass-balance.test.ts` (decision #8 enforced) |
| §15 | Decisions needing sign-off | ⏸ Moot until closures are revived; still open |
| §16 | Out of scope (`genesis_cell`, balance ranking, crystal variety, trade-as-sink) | Unchanged — `genesis_cell` is the sole legit-terminal in the ledger |

---

## 4. Re-framed remaining work (against the architecture that exists now)

The original three-phase plan is still directionally right, but the *mechanism* is now
different: **closing an orphan = flipping its `RESOURCE_META.terminal` from
`expansion-hook` to `consumed` by adding a real consumer (recipe input / new refine
recipe / placement cost), keeping `mass-balance.test.ts` green.** Priority order:

1. **Byproduct-gas throttle (correctness, P0).** The six non-CO₂ byproducts (2a) are
   still capped inventory bins with no sink — a long-run/offline emitter can stall on
   its own exhaust. Either (a) give each a real consumer loop (design §4), or (b)
   apply the same "bypass inventory" treatment co2 got to any genuinely-vented gas.
   First add a **regression test** that runs an emitter to a full byproduct bin and
   asserts no stall (the design's §14 pre-work check — still not present).

2. **Tag hygiene (cheap, P1).** Re-audit `expansion-hook` tags: move `biofuel`,
   `aviation_kerosene`, `air` (and any other genuinely-sunk resource) to
   `gameplay-sink`/`consumed` so the ledger's orphan count is honest. Shrinks the
   backlog with zero gameplay change.

3. **Bulk closures (content, P2).** Work §2b–§2h with the design's cheapest-fit rule
   (decision #6: prefer recipe-input adds + placement-cost edits; new buildings only
   when forced). The **placement-basket** closures (§10, §11 — machines/components →
   the buildings that obviously contain them) remain the highest-leverage, lowest-risk
   batch: placement-cost edits don't touch recipe shapes, so they can't break chains,
   and the auditor doesn't even apply to placement costs.

4. **`self_replication_module` (mechanic, P2).** The free-floor-token relief valve
   (design §13) is still unbuilt and still the only orphan without a natural recipe
   sink. Needs the §15 sign-off (any-floor vs. exponential-band-only) first.

5. **CO₂ global atmosphere (architecture, optional).** Now a *non-correctness*
   refactor. Only worth doing if a future feature needs a single global counter
   (e.g. cross-island sequestration markets, the `co2` "weather penalty + sequestration
   (Phase 6)" hook). If revived: **v26 → v27** migration folding
   `Σ co2Kg → atmosphericCo2Kg`; retarget `sumIslandCo2`.

---

## 5. Open decisions (design §15, still unresolved)

1. Free-floor tokens usable on any floor vs. only the §4.9 exponential band.
2. Orphan consumer recipes inherit producer tier for XP weight, or bespoke weights.
3. Fantasy T5 raws route as inputs into existing endgame recipes vs. dedicated chains.
4. The CO₂ feedstock set (Sabatier / concrete curing / agriculture) — only relevant
   if §2/§3 are revived.
5. Acceptable new-building count for the §6/§4 refine/condenser recipes.

Plus one **new** decision raised by this audit:

6. **Is the global-atmosphere CO₂ refactor still wanted at all?** Its correctness
   rationale is gone. Keep `co2` as a per-island scalar (status quo) unless a concrete
   future feature needs the global counter.

---

## 6. Out of scope (unchanged)

`genesis_cell` (sole legit-terminal, no win state) · the balance-ranking fixes in
`TODO.md` (coal_gen MW, alloy 1:1 ratios, lithography_lab, geothermal_vent, T6
satellite baskets) · skill-crystal recipe variety (already sunk by the skill tree) ·
trade/sell as a generic sink (a value dump, not a real consumer).

---

*Status update · 2026-06-19 · Robot Islands · resource-graph closure. Audited against
`SCHEMA_VERSION = 26`; `RESOURCE_META.terminal` taxonomy = 135 consumed / 67
gameplay-sink / 62 expansion-hook. Supersedes the planning content of the 2026-06-13
design.*
