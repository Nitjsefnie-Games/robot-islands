# CO₂-capture visibility in the building inspector — design

**Date:** 2026-06-19
**Status:** approved (brainstorming) → ready for plan
**Scope:** visibility only. No economy/wiring changes, no base-magnitude rebalance.

## Problem

`plant_a_tree` (and the other CO₂ sinks) feel useless to the player: upgrading a
tree, clustering a field of them, or running with a big active-play bonus
*appears* to do nothing. The reported symptoms were (a) floor upgrades don't do
anything, (b) cluster bonus doesn't do anything, (c) the inspector shows nothing.

## Verified findings (proved by driving `advanceIsland` directly)

The CO₂ drain at `economy.ts:2472` is `drainKg = co2CaptureKgPerCycle ×
effectiveRate × dtSec` for recipe-backed buildings, and `effectiveRate`
(`economy.ts:1489`) already multiplies in the full rate stack
(`buffStack` = cluster, `floorEffectMul`, `rateMul` = skill/NC/active/fledgling).
Measured over a 10-minute segment on a forest tile:

| Lever | Result | Verdict |
|---|---|---|
| Floor 0 → floor 3 | 1 → 4 kg captured (×4 = `floorEffectMul(3)=1+3`) | already works |
| 4 clustered trees | 1.15 kg/tree vs 1.0 lone (`1 + 0.05×(K−c_i)`) | already works |
| Active bonus ×2 | 1 → 2 kg | already works |

So (a) and (b) are **not** simulation bugs — the multipliers already flow into
capture. They are **invisible**.

The live inspector screenshot confirmed: a Plant a Tree shows
`RECIPE: cycle 60s · base 0.017/s`, `BONUS: cluster ×1.20 · active ×6.40`,
`CYCLES/S 0.130`, and `OUTPUT RATES: NO PRODUCTION`. The cluster/active
multipliers **are** displayed and **do** compute. What is missing:

1. **No statement that the building captures CO₂, or how much.** The player sees
   a cycle rate driving no output. Effective capture here is
   `0.1 kg/cycle × 0.130 cyc/s = 0.78 kg/min (~47 kg/hr)` — shown nowhere.
2. **The FLOORS upgrade copy lies for capture buildings:** `next: +2 throughput /
   capacity / power-out` — a tree has zero throughput/capacity/power-out. It
   should say CO₂ capture.

### Recipe-backed vs flat capture (shapes the design)

Only `plant_a_tree` has a `RECIPES` entry (`recipes.ts:3595`). `wastewater_treatment`
and `exhaust_scrubber` have **no** recipe, so their drain uses the `dtSec/60`
fallback: capture is **flat** (`co2CaptureKgPerCycle` kg/min), unaffected by
floor/cluster/active. The scrubber is additionally binary adjacency-gated
(`co2CaptureAdjacency`, `economy.ts:2463`). For non-recipe buildings the inspector
currently hits the `if (!recipe)` branch (`inspector-ui.ts:1657`) and shows
`— no recipe` plus hidden bonuses — i.e. nothing about capture at all.

## Design

### A. New "CO₂ Capture" inspector section

Rendered whenever `BUILDING_DEFS[defId].co2CaptureKgPerCycle > 0`. Sits below the
RECIPE section. Two display modes:

- **Recipe-backed (tree):**
  - Effective line: `CO₂ CAPTURE  0.78 kg/min` =
    `co2CaptureKgPerCycle × effectiveRate × 60`, where `effectiveRate` is the same
    `br.effectiveRate` the recipe section already pulls from the fresh
    `computeRates` pass (`inspector-ui.ts:1671-1673`). Live on every refresh.
  - Derivation line: `0.1 kg/cycle × 0.130 cyc/s` so the cluster/active
    multipliers already shown in RECIPE visibly translate into kg removed.
- **Flat (wastewater/scrubber):**
  - Effective line: `CO₂ CAPTURE  5.0 kg/min (flat)` = `co2CaptureKgPerCycle`
    (since flat cadence is 1 cycle / 60 s).
  - Scrubber adjacency status: `ACTIVE` when a `co2CaptureAdjacency` neighbour is
    present, else `IDLE — needs adjacent emitter` (mirror the `economy.ts:2463`
    gate, reusing `hasNeighborWithAnyDefId` or the inspector's existing neighbour
    helpers). When idle, effective capture reads `0.0 kg/min`.

The section computes its own value from already-available data; **no change to
`economy.ts`.** The flat vs recipe-backed branch is decided by whether
`resolveRecipe` returns a recipe (same predicate the drain uses).

### B. Floor-upgrade copy fix

In the FLOORS section, the "next: +N throughput / capacity / power-out" preview is
built from generic terms. For a def with `co2CaptureKgPerCycle > 0` and no
resource output, replace the throughput term with "CO₂ capture" so the upgrade's
real effect is honest (e.g. `next: +2 CO₂ capture`). Buildings that both produce
and capture keep the throughput wording. (Note: flat capture buildings do **not**
scale with floors — for those, omit the CO₂-capture term from the floor preview to
avoid implying a benefit that the `dtSec/60` fallback ignores.)

### C. Regression tests

Lock the behavior proved above so it can never silently regress:

1. `economy` test: floor-upgraded tree captures `floorEffectMul(level)`× a
   floor-0 tree (assert ×4 at floor 3).
2. `economy` test: a 4-tree cluster captures `1 + 0.05×(K−c_i)`× per tree vs a
   lone tree (assert ≈ ×1.15).
3. `economy` test: `activeBonusMul = 2` doubles capture.
4. `inspector-ui` test: the CO₂ Capture line renders the expected kg/min for a
   recipe-backed tree (compute from a known effectiveRate) and the flat value +
   adjacency status for a scrubber (active and idle).

## File touch-points

- `src/inspector-ui.ts` — new section (A), floor-copy branch (B).
- `src/inspector-ui.test.ts` — section render tests (C4).
- `src/economy.test.ts` — scaling regression tests (C1–C3).
- No `economy.ts`, `recipes.ts`, or `building-defs.ts` changes.

## Out of scope (explicitly not now)

- Raising `co2CaptureKgPerCycle` (base magnitude). The multipliers already make a
  full upgraded/clustered island capture megatonnes/hr; magnitude is a separate
  balance decision.
- Making flat capture buildings (wastewater/scrubber) scale with floor/cluster by
  giving them recipes. Possible follow-up, not this change.
- Any new tree-specific synergy mechanic.

## SPEC.md alignment

This is a UI/display change with no mechanic change, so no SPEC.md section is
altered. The §7.4 CO₂-sink mechanic and §4.x multipliers are unchanged; the
inspector merely surfaces values the simulation already produces.
