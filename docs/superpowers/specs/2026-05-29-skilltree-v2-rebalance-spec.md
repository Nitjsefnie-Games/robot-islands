# Skill-tree rebalance v2 — spec (DRAFT, iterating)

**Status:** draft for review · **Date:** 2026-05-29 · **Author:** Opus 4.8
**Builds on:** `2026-05-29-skilltree-v2-audit` (foundation) · `2026-05-25-skilltree-rebalance-design` (v1, schema v14, shipped)
**Sequencing:** executes **after** the throughput-floors rebalance (already underway); **not** in parallel.

> This spec is decision-complete on the *structure* (lever ownership + node budget)
> and deliberately exposes the unhomed/contentious calls rather than papering over
> them — those rows are the iteration surface. Magnitude numbers are derived by
> existing machinery, not hand-set here.

> **Decision-complete (2026-05-29).** All open questions resolved (§11). Two
> approvals interacted: **(a)** robotics hosts `manufacturing-rate` + `droneFuel`,
> `constructionTimeMul` → notable (manufacturing-rate displaced the 3rd chain);
> **(b)** storage keeps its four per-category caps and drops the generic — these are
> **one capacity lever sliced by resource category**, not multiple generic filler
> chains, so the ≤2-chain budget isn't tripped.

---

## 1. Goal & non-goals

**Goal.** Reverse v1's "many tiny nodes" tradeoff while keeping v1's cap framework.
Concretely: (a) cut every subpath to **≤2 filler chains** so per-node gains are
perceptible again; (b) stop branches from re-implementing levers that already have
a home (the cross-branch dilution the effect-kind audit hid); (c) add a "magical"
material-input-efficiency lever to refinement.

**Non-goals.**
- **Do not** change v1's pool caps (×10 / √10 / ÷10 / ×3-xp) or the
  `C^(w/N)−1` magnitude formula. Keep `deriveMagnitudes()` + its CI test.
- **Do not** redesign the graph topology, UI, cost-doubling depth model, auras,
  crystals, or sockets.
- **Do not** touch notables/keystones except where a rehomed lever forces it —
  the de-noding is a **filler-chain** operation. Notables/keystones already
  supply the curated jumps.

---

## 2. Locked decisions (quick reference)

| # | Decision |
|---|---|
| **A** | Per-lever ownership map: 4 SPLIT / 6 CONSOLIDATE (§4). Ocean survives as a full 5-subpath branch. |
| **Q1** | Node budget: **≤2 filler chains + notables + keystone(s) per subpath, ≤23 total.** Sparse subpaths **stay sparse** — no padding. |
| **Q2** | Magnitudes stay **derived/calculated** (`skilltree-derive-magnitudes.ts` + `skilltree-magnitudes.test.ts`); feed the smaller N. |
| **Q3** | Resolved by the map: extraction = two thin pools (generalist rate + specialist yield); storage = one home. |
| **Q4** | Magical `recipeInputMul` pool: shared across smelting/chemistry/electronics, **÷1.5** ceiling, **T3+ gated**, **base SP price above the standard curve**. |
| **Q5** | After throughput-floors; sequential. |

---

## 3. The de-noding mechanism (Q1)

Each subpath's filler nodes are generated from a list of **archetypes** in
`src/skilltree-archetypes.ts`: `<SUBPATH>_FILLER_ARCHETYPES: FillerArchetype[]`,
each fed through `generateFillerNodes(arch)`. One archetype = **one effect kind**
(`effectKind` + `effectExtra`) ramped over `count` depths = **one filler chain**.

**Current bloat:** most subpaths carry **3–4 archetypes** (e.g. Mining =
`recipeRateMul:extraction`, `storageCategoryCapMul:dry_goods`, `mineYieldBonusMul`,
`mineRareTrickleMul`). That is the dilution.

**v2 rule:** each `*_FILLER_ARCHETYPES` array drops to **≤2 archetypes**, chosen
per the ownership map (§4). The total node count per subpath (2 chains + notables +
keystone) must be **≤23**. Subpaths whose levers all rehome elsewhere are allowed
to fall to **1 chain or even 0** — sparse stays sparse.

The "≤2" counts **distinct lever-families**, not raw archetype rows. A single lever
sliced into specific variants (storage's per-category caps —
`storageCategoryCapMul:<cat>` × 4) counts as **one** family, so storage's category
chains do not trip the budget. The rule targets a subpath hoarding *unrelated*
generic levers, which is the dilution v2 removes.

Magnitude per node falls out automatically: `deriveMagnitudes()` sizes each node so
the chain's product hits its filler-tier share of the (unchanged) pool cap. Fewer
nodes → punchier nodes, no formula change.

---

## 4. Per-subpath v2 plan (the iteration surface)

`KEEP` = surviving filler chain. `→X` = lever rehomed to branch/subpath X.
`drop` = removed (was pure dilution). All rows **LOCKED** (decision-complete).

### Extraction
| Subpath | v2 filler chains (≤2) | Rehomed / dropped | Notes |
|---|---|---|---|
| **mining** | `recipeRateMul:extraction`, `mineYieldBonusMul` | dry_goods cap → logistics/storage; `powerConsumptionMul` → drop; `mineRareTrickleMul` → demote to notable | clean |
| **forestry** | `recipeRateMul:extraction`, `loggerYieldBonusMul` | dry_goods cap → storage; `loggerExoticTrickleMul` → notable | `unlockRecipe` keystone kept |
| **drilling** | `recipeRateMul:extraction`, `drillYieldBonusMul` | liquid_gas cap → storage; duplicate `mineYieldBonusMul` → drop; `mineRareTrickleMul` → notable | `tierBypass` keystone kept |
| **robotics** | `recipeRateMul:manufacturing`, `droneFuelEfficiencyMul` | `droneScanRadiusMul` → discovery; `constructionTimeMul` + `parallelBuildCapAdd` → notable | LOCKED: manufacturing-rate wins the 2-of-3; constructionTime → notable |

### Refinement
| Subpath | v2 filler chains (≤2) | Rehomed / dropped | Notes |
|---|---|---|---|
| **smelting** | `recipeRateMul:smelting`, **`recipeInputMul` (magic)** | `powerConsumptionMul` → power_systems; `maintenanceThresholdMul` → resilience | `biomeBypass` keystone kept |
| **chemistry** | `recipeRateMul:chemistry`, **`recipeInputMul` (magic)** | liquid_gas cap → storage; `powerConsumptionMul` → power_systems | |
| **electronics** | `recipeRateMul:electronics`, **`recipeInputMul` (magic)** | `powerConsumptionMul` → power_systems; `satBufferCapMul` → orbital/launch | |
| **power_systems** | `powerProductionMul`, `powerConsumptionMul` | `batteryCapacityMul` → notable; `xpGainMul` → notable | **the single power home**; receives consolidated power from smelting/chem/elec + extraction strays + ocean |

### Logistics
| Subpath | v2 filler chains (≤2) | Rehomed / dropped | Notes |
|---|---|---|---|
| **storage** | `storageCategoryCapMul:{dry_goods, liquid_gas, components, rare}` — generic `storageCapMul` **removed** | `maintenanceThresholdMul` → resilience; `recipeRateMul:manufacturing` → robotics | LOCKED: the 4 per-category caps are **one capacity lever, category-sliced** (specific, not generic filler) — within budget; ≤23 total |
| **transport** | `routeCapacityMul`, `airshipRangeMul` | `droneFuelEfficiencyMul` → robotics (same pool) | |
| **network** | `teleporterEfficiencyMul` (1 chain) | `commRangeMul` → orbital/communication; `scannerCoverageMul` → orbital/discovery | `crossIslandShared` keystone kept · deliberately sparse (1 lever) |

### Orbital
| Subpath | v2 filler chains (≤2) | Rehomed / dropped | Notes |
|---|---|---|---|
| **launch** | `launchSuccessAdditive`, `satBufferCapMul` | `padExplosionReduceMul` → notable; `satFuelReserveMul` → notable | niche → sparse OK; absorbs electronics' satBuffer |
| **communication** | `commRangeMul` (consolidated comm home) | `scannerCoverageMul` → discovery; `satBufferCapMul` → launch | `conditionalBonus` keystone kept; ~1 strong chain — sparse OK |
| **discovery** | `scannerCoverageMul` (consolidated scan home), `droneScanRadiusMul` | `scannerDwellRateMul` → notable | absorbs robotics + ocean drone-scan |
| **resilience** | `debrisProtectionMul`, `maintenanceThresholdMul` (consolidated maint home) | `repairDroneReliabilityMul` → notable | absorbs smelting + storage maintenance |

### Ocean (must survive as a full branch)
| Subpath | v2 filler chains (≤2) | Rehomed / dropped | Notes |
|---|---|---|---|
| **aquaculture** | `recipeRateMul:extraction` (sea-extraction split), `aquacultureYieldBonusMul` | dry_goods cap → storage; duplicate `mineYieldBonusMul` → drop | clean |
| **hydroprocessing** | `recipeRateMul:chemistry` (sea-chemistry split) (1 chain) | `powerConsumptionMul` → power_systems; `storageCapMul` → **drop** (generic removed) | deliberately sparse (1 lever); magic is refinement-only, not here |
| **submarine** | `routeCapacityMul` (sea-cargo split), `airshipRangeMul` | `powerProductionMul` → power_systems | LOCKED: keep `airshipRangeMul` (your vote) |
| **oceanography** | `scannerCoverageMul` (sea-survey split), `t5ExtractorYieldBonusMul` | `commRangeMul` → orbital; `droneScanRadiusMul` → discovery | `exoticAdjacency` keystone kept |
| **patronage** | `patronageYieldBonusMul` (1 chain) | `recipeRateMul:extraction` → drop (not an extractor); `commRangeMul` → orbital; rare cap → storage | LOCKED: accept sparse 1-chain subpath (your vote) |

---

## 5. Unhomed levers & deliberately-sparse subpaths

Surfaced explicitly so review lands here, not in the prose. **Round-2 resolutions in bold.**

- **`recipeRateMul:manufacturing`** (9 nodes, was in storage) — **RESOLVED → robotics**
  (your vote). Forces robotics' 2-of-3 chain choice (see §4).
- **Per-category storage caps** (`dry_goods`/`liquid_gas`/`components`/`rare`) —
  **RESOLVED: keep all four specifics, remove the generic `storageCapMul`, recalc**
  (your vote). The four category caps are **one capacity lever sliced by resource
  category** — specific, not generic filler — so they count as a single lever-family
  and stay within the ≤2-chain budget (≤23 total). No "exception" needed.
- **Patronage identity** — **RESOLVED: accept the deliberately sparse 1-chain
  subpath** (`patronageYieldBonusMul`) (your vote). No sponsorship-lever redesign.
- **Deliberately sparse (accepted):** patronage, network (teleporter only),
  communication (comm only), hydroprocessing (sea-chemistry only), launch.
- **Demoted to notables:** `constructionTimeMul`, `mineRareTrickleMul`,
  `loggerExoticTrickleMul`, `parallelBuildCapAdd`, `batteryCapacityMul`, `xpGainMul`,
  `scannerDwellRateMul`, `repairDroneReliabilityMul`, `padExplosionReduceMul`,
  `satFuelReserveMul`.

---

## 6. Magical input-efficiency lever (Q4)

**New effect kind** in `src/skilltree.ts`'s `SkillEffect` union:
```ts
| { readonly kind: 'recipeInputMul'; readonly reduce: true }
```
Multiplies recipe **input** quantities down (outputs unchanged) at runtime in the
economy fold (`effectiveSkillMultipliers` → consumed in `economy.ts` `computeRates`).

- **Home:** refinement, as the 2nd filler chain in **smelting, chemistry, electronics**
  (the three material-consuming subpaths; power_systems doesn't refine matter). Three
  chains feed **one shared pool** capped at **÷1.5** (≈33% less input at full).
- **Gate:** T3+ (depth threshold), so it's an earned late-game reward.
- **Cost:** elevated `baseCost`/`costGrowth` on these archetypes so total SP to max the
  magic pool runs **~1.5–2× a comparable normal pool** — magic is premium.

**Correction to the audit (verified, not assumed).** The audit said to exempt this
like `RECIPE_SPECULATIVE`. **That is the wrong mechanism.** `src/mass-balance.test.ts`
audits the **static `RECIPES` table** (`Object.entries(RECIPES)`, summing
`RESOURCE_META[r].massPerUnitKg`) and skips entries flagged in `RECIPE_SPECULATIVE`
(keyed by `RecipeId`). `recipeInputMul` is a **runtime skill multiplier** — it never
edits the static recipe table, so the auditor **cannot see it and no exemption is
needed.** The static recipes still balance; the skill bends the ratio only at tick
time. The "magic" is fiction-level, not an auditor concern. **Decided: no extra
invariant test** (your vote) — a guard that "only the magical lever may push effective
inputs below outputs" would be a new, separate test (not the `RECIPE_SPECULATIVE`
path), deliberately not added.

---

## 7. Magnitudes (Q2)

No formula change. After the filler-chain cuts, re-run `deriveMagnitudes()` against
the smaller per-pool N; the CI guard `src/skilltree-magnitudes.test.ts` re-asserts
each pool's product equals its cap. The `recipeInputMul` pool is registered as a
**reduce-pool** with cap `1/1.5`. Per-node magnitudes will rise (the intended punchy
feel) purely as a consequence of smaller N.

**Storage recalc (round-2):** the generic `storageCapMul` pool is removed; each
`storageCategoryCapMul:<cat>` pool is re-derived to hit the full per-category cap on
its own (previously the generic stacked on top of every category, double-counting).

---

## 8. Persistence migration

Removing filler node ids invalidates saved `unlockedNodes`, so this is a schema bump
+ ladder reset (preserve buildings/inventory), exactly like v1's v13→v14.

- **Current committed schema = `SCHEMA_VERSION = 16`** (`src/persistence.ts:79`). v2
  is sequenced *after* throughput-floors and more bumps may land first, so the
  migration target is **"current committed + 1 at implementation time"**, not a
  hard-coded number. Do not assume v17 — re-read `persistence.ts` when implementing.
- Follow the AGENTS.md migration discipline: add `SerializedSnapshotV<N>` alias,
  `migrateV<N>toV<N+1>` (refund all spent SP, clear `unlockedNodes`, keep buildings/
  inventory/xp), wire into `loadWorld`, add `N` to `SUPPORTED_LOAD_VERSIONS`, tests.

---

## 9. Sequencing & interactions (Q5)

- **After** throughput-floors lands (already underway). v2 re-derives magnitudes
  against the same mechanic floors changes, so doing it in parallel = deriving
  against a moving target.
- **Combined-ceiling check (required before lock):** input-efficiency `÷1.5` ×
  rate `×10` × floor `×(1+L)` must be verified as an intended ceiling, not an
  accidental runaway, once all three are live.

---

## 10. Verification / acceptance

- `npm test` green.
- New/updated test: **every subpath has ≤2 distinct filler lever-families and ≤23
  total nodes** (assert against `*_FILLER_ARCHETYPES` + notables + keystones).
  Per-category variants of one lever count as **one** family — storage's four
  `storageCategoryCapMul:<cat>` archetypes are a single capacity family, so the
  assertion must group by lever-family, not raw archetype count.
- `skilltree-magnitudes.test.ts`: each pool's product still equals its (unchanged) cap.
- `mass-balance.test.ts`: still green — `recipeInputMul` introduces **no** new
  skips (proves it's invisible to the static auditor).
- Migration test: a v16 (or then-current) fixture loads, SP refunded, `unlockedNodes`
  cleared, buildings/inventory preserved; round-trip identity at the new version.
- Manual: confirm `recipeInputMul` reduces consumed inputs at runtime and is T3-gated.

---

## 11. Open questions for this iteration

**Resolved this round (your votes):**
1. ✅ **robotics** — manufacturing-rate + droneFuel (constructionTime → notable).
2. ✅ **storage** — remove generic, keep + recalc the 4 specifics.
3. ✅ **manufacturing-rate** — → robotics.
4. ✅ **patronage** — accept the sparse 1-chain subpath.
5. ✅ **submarine** — keep `airshipRangeMul`.
6. ✅ **magic** — ÷1.5 ceiling, T3 gate.
7. ✅ **magic invariant test** — none; "the static auditor can't see it" is sufficient.

**Collisions surfaced by the votes — now resolved:**
- ✅ **Robotics 2-of-3** — `manufacturing-rate` + `droneFuelEfficiencyMul`;
  `constructionTimeMul` → notable.
- ✅ **Storage "2-chain" worry** — non-issue: the 4 per-category caps are one
  capacity lever sliced by category, not unrelated generic chains.

**Spec is decision-complete.** Next step: `writing-plans` for the implementation plan.
