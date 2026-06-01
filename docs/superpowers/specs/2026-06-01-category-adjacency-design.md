# Universal per-category adjacency — design

**Date:** 2026-06-01
**Branch:** `feat/category-adjacency`
**Status:** Approved (brainstorming), pending implementation plan

## Problem

The current buff-adjacency mechanic (`SPEC §4.5`, `adjacency.ts:computeBuffStack`)
is **per-def data**, not a rule. Only three building defs carry a `same_def`
clustering buff:

| Def | `percentPerMatch` | `maxMatches` |
|---|---|---|
| `mine` | 10% | 2 |
| `smelter` | 10% | 2 |
| `workshop` | 5% | 3 |

Every other building gets nothing. Yet the tutorial (`tutorial.ts:257`) advertises
a universal *"Cluster same-type buildings for a +10% output bonus."* — which is
wrong three ways:

1. It is not universal (only 3 of ~200 defs have it).
2. The magnitude is not uniformly +10% (workshop is +5%).
3. It says "output" — the buff already multiplies **recipe rate**
   (`economy.ts:1063`, `baseRate = (1/cycleSec) × buffStack × …`), so inputs and
   outputs scale together.

The current mechanic is also **capped** (`maxMatches`) and **multiplicative across
entries**, neither of which matches the desired feel.

## Goal

Replace the per-def clustering buff with a single universal rule:

- **Per-category**, not per-def — buildings buff same-**category** neighbors
  (`manufacturing`, `extraction`, `smelting`, …).
- **Incremental & linear** — 2 adjacent = +20%, not 1.1².
- **Uncapped** — geometry is the only limit.
- Applies to **recipe rate** (already does) **and generator output** (new);
  **not** power consumption.

## The rule

Each building computes one **category-adjacency multiplier**:

```
categoryMul = 1 + (distinct same-category buildings touching the focal's
                   physical 4-neighbor border) × rate[focal.category]
```

- **Same-category** match: `defs[neighbor.defId].category === defs[focal.defId].category`.
- **Distinct neighbors**, de-duped by building id (a multi-tile neighbor crossing
  several border tiles counts once — existing `computeBuffStack` semantics).
- **Physical 4-neighbors only**: same island, von-Neumann (cardinal) border ring,
  per `SPEC §4.4` ("union of tiles bordering any cell of the footprint, minus the
  footprint itself"). **"4-neighbor" is the adjacency *rule* (cardinal, not
  diagonal), NOT a cap of 4 neighbors** — a 2×2 footprint exposes 8 border tiles
  and can be surrounded by 6+ distinct same-category neighbors, all of which count.
- **Uncapped, raw count**: no `maxMatches`, no perimeter normalization. A larger
  footprint exposes a longer border ring and can therefore collect more neighbors —
  this is intended; deliberate base-planning geometry is rewarded.
- **Cross-island lattice (`§13.3`) does NOT feed this term** — physical adjacency
  only.

### Rate table

New `CATEGORY_ADJACENCY_RATE: Record<BuildingCategory, number>` in
`building-defs.ts`, every category seeded at **0.10**, tunable per-category later.

Categories: `extraction, smelting, chemistry, manufacturing, electronics, power,
storage, logistics, cooling, production, special`.

Categories whose buildings neither run a recipe nor generate power (`storage`,
`logistics`, `cooling`) are harmless no-ops even at 0.10 — the multiplier has
nothing to scale. They can be zeroed during balance tuning if the inspector
advertising a phantom bonus is undesirable.

## Where it applies

| Target | Location | Change |
|---|---|---|
| Recipe rate | `economy.ts:1063` | `buffStack` already multiplies `baseRate`; `buffStack` becomes `categoryMul × exoticPairs`. Inputs + outputs scale together. |
| Generator output | `economy.ts:1195` | **New:** multiply `powerProduced` by the power building's `categoryMul`. Clustering generators boosts generation. |
| Power consumption | `economy.ts:1199` | **Unchanged** — `powerConsumed` already excludes `buffStack`. A buffed consumer runs faster but draws the same wattage. |

## What stays / what is removed

**Removed:**

- `adjacencyBuffs[]` entries on `mine`, `workshop`, `smelter`.
- The `AdjacencyBuff` type and `same_def` / `def_id` *buff* matching inside
  `computeBuffStack` (the `same_def`/`same_category`/`def_id` literals survive
  independently as `GateMatchType` for gates — untouched).

**Kept:**

- **Skill-tree exotic-pair boosts** (`skillUnlockedAdjacencyRules`,
  `skilltree.ts:1126`, `exoticAdjacency`/`pairBoost` node effects). These are
  *unlock rewards*, not static config — stripping them would silently gut a
  skill-tree node. They multiply on top of `categoryMul` and retain their current
  neighbor semantics (physical + cross-island lattice) so the skill tree does not
  regress.
- **Gates** (`checkGates`) — separate hard/soft requirement mechanic, untouched.

### `computeBuffStack` neighbor sets

The rewrite needs two neighbor views:

- `physicalNeighbors` — border-touching, same island. Feeds the category count.
- `physicalNeighbors + crossIsland` — feeds the exotic-pair loop only (preserves
  current skill-reward behavior).

Return value: `categoryMul × Π(exotic pair bonuses)`. Returns `1.0` when the
focal building has no same-category physical neighbors and no exotic rules apply.

## Files to change

- `adjacency.ts` — rewrite `computeBuffStack`; remove `same_def`/`def_id` buff
  matching and `neighborMatches`/`AdjacencyBuff` usage for buffs.
- `economy.ts` — apply `categoryMul` to `powerProduced` in the pass-3 power loop.
- `building-defs.ts` — add `CATEGORY_ADJACENCY_RATE`; strip the three
  `adjacencyBuffs` entries and the `AdjacencyBuff` type + def field.
- `tutorial.ts:257` — fix hint to same-**category**, flat-per-neighbor, uncapped
  wording. (Trigger `hasAdjacentSameType` still fires: two mines are both
  `extraction` and adjacent.)
- `SPEC.md §4.5` (buff form) — rewrite to the category rule; `§5` (power) — note
  generation scales by adjacency.

## Testing

- `adjacency.test.ts` — rewrite buff cases: same-category linear count, uncapped
  (5 neighbors → ×1.50), distinct-by-id de-dup, multi-tile footprint border ring,
  cross-island excluded from category term, exotic pairs still stack on top.
- `economy` — new test: clustered generators produce more power; clustered
  consumer runs faster but draws unchanged wattage.
- `tutorial.test.ts` — existing `12_adjacency` trigger still passes.

## Non-goals / notes

- **No persistence migration.** `adjacencyBuffs` is static def data; `buffStack`
  is computed per tick and never serialized. (Verify no snapshot field references
  it during implementation.)
- Cross-island lattice participation in the category term is explicitly out of
  scope; can be revisited as a later tuning pass.
- Per-category divergent rates are out of scope for v1 (table exists, all 0.10);
  tuning is a follow-up.
