# Skill-tree audit — over-noding, per-node dilution, missing efficiency lever

**Date:** 2026-05-29. **Purpose:** foundation for the **skill-tree rebalance v2** spec.
**Builds on:** `2026-05-25-skilltree-rebalance-design` (v1, schema v14, implemented) +
its pool/magnitude framework. **Data:** live catalog survey via `vite-node` against
`src/skilltree.ts` this session (current schema v15).

## TL;DR

v1 fixed the **multiplier runaway** (×10⁹ → cap every pool at ×10 via calibrated
magnitudes) but did it by **adding nodes** (its rule: "N≥5 per effect kind to avoid cliff
magnitudes"). That deliberate "many tiny nodes" choice is exactly what now makes per-node
gains **imperceptible** (e.g. 54 power nodes summing to ×10 = **+4.4 %/node**). The caps are
right; the **node counts and per-node feel are wrong**, and one core lever — **material-input
efficiency** — doesn't exist at all. v2 should **reverse v1's tradeoff**: same ×10 caps,
far fewer/punchier nodes, redundant paths merged, plus a new "magical" input-efficiency
subpath.

## §1 How to measure over-noding (the methodology v1's analysis lacked)

Three rules — counting raw effect-kind totals is misleading without them:

1. **Generic + specific STACK.** A generic effect applies on top of every specific variant,
   so the effective node count for a single outcome = generic + that variant. (Storage:
   generic `storageCapMul` 16 adds to each `storageCategoryCapMul:<cat>`.)
2. **Group by ECONOMIC OUTCOME, not effect-kind name.** Effects that produce the same
   in-game result share one budget. Reducing consumer draw and raising producer output are
   the *same* lever ("power headroom" = produced/consumed ratio). Recipe-rate and per-extractor
   yield both raise extraction throughput.
3. **Cap ≠ count. Per-node impact matters.** v1 capped each pool's *total* at ×10 but left
   the *count* high, so per-node magnitude is `cap^(1/N)`. At N=54 → ×10 that's +4.4 %/node —
   a node should feel like an upgrade, not a rounding error.

## §2 Relationship to v1 (2026-05-25)

| v1 did | consequence / gap for v2 |
|---|---|
| Capped every pool at ×10 via `m = C^(w/N)−1` (no clamp) | Caps are correct — **keep the framework**. |
| **Added 48 nodes**; rule "N≥5 to avoid cliff magnitudes" | **Root of the dilution.** v2 reverses this: fewer nodes, bigger per-node. |
| Power = one *net* shrink-each pool (consume ÷√10 × produce ×√10 → ×10) | Already grouped by outcome (matches §1.2). Only the 54-node count is the issue. |
| Extraction = one shared pool (rate + per-building yield, 50/50 → ×10) | Already grouped. Only the count (~66 effective on a Mine) is the issue. |
| Added rate/yield/power/storage caps only | **No material-input-efficiency lever** — v2 adds it. |
| Left `rebalance-magnitudes.py` + a CI magnitude-invariant test | v2 reuses both (re-derive magnitudes for the smaller N). |

v1 was not wrong about the runaway; v2 is the **second-order cleanup** of the tradeoff v1 chose.

## §3 Data — current catalog (~553 nodes)

### Full effect-kind distribution (effect-bearing nodes)

| effect kind | nodes | | effect kind | nodes |
|---|---|---|---|---|
| recipeRateMul | 100 | | droneFuelEfficiencyMul | 16 |
| storageCategoryCapMul | 54 | | storageCapMul | 16 |
| powerConsumptionMul | 37 | | airshipRangeMul | 12 |
| commRangeMul | 33 | | debrisProtectionMul | 10 |
| scannerCoverageMul | 32 | | mineRareTrickleMul / batteryCapacityMul / launchSuccessAdditive | 9 |
| routeCapacityMul | 22 | | drill/constr/patronage/aqua/t5Yield + storage components/rare | 8 |
| maintenanceThresholdMul | 20 | | loggerYieldBonusMul / xpGainMul | 7 |
| mineYieldBonusMul | 19 | | parallelBuildCap/teleporter/pad/scannerDwell/repair | 6 |
| droneScanRadiusMul | 19 | | loggerExoticTrickle / satFuelReserve | 5 |
| satBufferCapMul | 18 | | structural/unlockRecipe/tierBypass/biomeBypass/exoticAdj/crossIsland/conditional | 1 each |
| powerProductionMul | 17 | | | |

### `recipeRateMul` (100) by category — only extraction is the offender

| category | nodes | verdict |
|---|---|---|
| extraction | 47 | over |
| chemistry | 22 | marginal |
| smelting | 11 | ok |
| electronics | 11 | ok |
| manufacturing | 9 | ok |

(no generic `recipeRateMul` — all per-category.)

### `storageCategoryCapMul` (54) — generic stacks onto each category

generic `storageCapMul` = **16** (applies to all). Effective per category = 16 + specific:

| category | specific | effective (gen+spec) |
|---|---|---|
| dry_goods | 22 | **38** |
| liquid_gas | 16 | **32** |
| components | 8 | **24** |
| rare | 8 | **24** |

All over once stacking is counted.

### Power = one lever (consume + produce)

`powerConsumptionMul` 37 + `powerProductionMul` 17 = **54 nodes** for the single
"power headroom" outcome (v1 already caps the *net* at ×10).

### Per-node magnitudes (from v1 §03) — the dilution, quantified

| lever | N | per-node | feel |
|---|---|---|---|
| recipeRateMul:extraction | 47 | +2.48 % | imperceptible |
| powerConsumptionMul | 37 | +3.16 % | imperceptible |
| power headroom (54) | 54 | ≈+4.4 % | imperceptible |
| commRangeMul | 33 | +7.2 % | weak |
| storageCategoryCapMul:dry_goods | 22 | +5.4 % | weak |

## §4 Over-noded levers (effective, ~15–20 cap)

| economic lever | effective nodes | components | verdict |
|---|---|---|---|
| Mine throughput | **66** | extraction-rate 47 + mineYield 19 | worst (double-boosted) |
| Power headroom | **54** | consume 37 + produce 17 | over |
| Storage dry_goods | **38** | generic 16 + 22 | over |
| commRangeMul | 33 | generic | over |
| scannerCoverageMul | 32 | generic | over |
| Storage liquid_gas | 32 | 16 + 16 | over |
| other extractors' throughput | ~54 | extraction-rate 47 + per-extractor yield | over |
| Storage components / rare | 24 | 16 + 8 | over |
| routeCapacityMul / chemistry-rate / maintenance | 20–22 | generic / category | marginal |
| powerProductionMul alone / mineYield alone / storage generic | ≤19 | — | fine alone, but stack |

Root structural cause: **redundant paths boosting one outcome** — extraction (category-rate *and*
per-extractor yield), storage (generic *and* per-category), power (consume *and* produce).

## §5 Missing lever — material-input efficiency (the "magical" subpath)

- **Gap:** every skill scales *time* (`recipeRateMul`), *yield* (extractor bonuses), *power*,
  *storage* — **none scale the input→output ratio.** (`powerConsumptionMul` is power, not materials.)
- **Proposal:** new effect kind `recipeInputMul {reduce:true}` — multiplies recipe **input**
  quantities (outputs unchanged) — as a dedicated subpath summing to **÷1.5 input at full**
  (≈33 % less material), spread across a *small* number of meaningful nodes.
- **Why "magical":** reducing input below output **violates the SI kg mass-balance** the
  auditor enforces — so it must be **exempted** (like `RECIPE_SPECULATIVE`). That intentional
  mass-balance break is the in-fiction "magic," and the clean reason to segregate the subpath.

## §6 v2 thesis & recommendations (deltas from v1)

1. **Keep** v1's cap-per-pool framework, the `C^(w/N)−1` magnitude formula, the pool
   definitions, the magnitude CI test, and the ×10 / √10 / ÷10 / ×3-xp caps.
2. **Reverse v1's "N≥5 / many tiny nodes."** Contract each pool to **~15–20 nodes** (the user's
   tolerance), accepting punchier per-node magnitudes (the "cliffs" v1 avoided are now wanted).
   Re-derive magnitudes for the smaller N.
3. **Merge redundant paths per economic outcome:** pick ONE path per lever and cap the survivor
   — e.g. keep per-extractor yield, thin generic extraction-rate (or vice-versa); keep
   per-category storage, drop/shrink generic `storageCapMul`; power already net-capped, just
   cut the 54-node count.
4. **Add the magical input-efficiency subpath** (`recipeInputMul`, ÷1.5, auditor-exempt).
5. **Migrate** — removing node ids invalidates `unlockedNodes`; schema bump + reset the skill
   ladder like v1's v13→v14 (preserve buildings/inventory).
6. **Interaction:** input-efficiency (÷1.5) and rate (×10) stack with the floor mechanic
   (×(1+L)) from the throughput pass — verify combined ceilings are intended.

## §7 Open questions for the v2 spec

1. **Node-count target** per pool — flat ~15–20, or per-tier-of-importance (core 15–20, niche 3–4)?
2. **Per-node band** — target ~1.2–1.6× per node, or a few hand-curated "notable" jumps + minimal filler?
3. **Which redundant path to keep** for extraction (category-rate vs per-extractor yield) and storage (generic vs per-category)?
4. **Magical subpath** size/curve — how many nodes to reach ÷1.5, and does it gate behind a tier?
5. **Sequencing** — after throughput/floors + tutorial (current default), or sooner?
