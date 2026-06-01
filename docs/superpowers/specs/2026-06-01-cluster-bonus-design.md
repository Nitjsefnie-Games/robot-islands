# Cluster bonus — design

**Date:** 2026-06-01
**Branch:** `feat/cluster-bonus`
**Status:** Approved (brainstorming), pending implementation plan

## Problem

The current §4.5 buff-adjacency mechanic (`adjacency.ts:categoryAdjacencyMul`)
counts a building's **distinct same-category 4-neighbours** and returns
`1 + n × CATEGORY_ADJACENCY_RATE[category]`. The count is local to each
building's own footprint border, so the bonus is **positional**: an interior
building in a block beats an edge building, and an edge building beats a corner.

This penalises small / undeveloped islands. With only a handful of same-category
buildings you can rarely give any one of them more than one or two neighbours, so
the multiplier stays near ×1.1 even when every building you own is part of one
tight block. The reward for "I packed my whole economy into one cluster" is
diluted by the geometry of which building sits where.

## Goal

Make the bonus a property of the **whole cluster**, not the individual building's
neighbour count. Every member of a connected same-category cluster gets the
**same** multiplier, scaled by the cluster's size. This deliberately and
substantially changes layout strategy — that is the point: it lets a small island
that consolidates its same-category buildings into one contiguous block reach the
full multiplier instead of being capped by short rows and edge positions.

## Design

### Cluster definition

A **cluster** is a maximal set of **same-category** buildings connected by
**4-adjacency**, using the existing footprint border test (`touchesBorder` in
`adjacency.ts`):

- Two buildings are linked iff one's footprint border tile overlaps the other's
  footprint (the same §4.4 4-neighbor test used today). Diagonal-only contact is
  **not** a link.
- A multi-tile building is a single node (counts once), regardless of how many
  border tiles it shares.
- Connectivity is **within a single category**. A different-category building
  sitting between two same-category buildings does **not** bridge them.
- **"No gaps" = connectivity only (R1).** Enclosed empty tiles are irrelevant.
  A ring of 8 same-category buildings around 1 empty interior tile is one valid
  cluster of size 8. No solid-fill / hole-penalty rule.

### Formula

For a building whose same-category 4-connected cluster has size `k`:

```
mul = 1 + (k − 1) × CATEGORY_ADJACENCY_RATE[category]
```

- Rate stays **0.10** and `CATEGORY_ADJACENCY_RATE` keeps its name and values.
- Isolated building → `k = 1` → ×1.0.
- Categories with rate 0 → ×1.0 (the existing short-circuit is preserved).
- The multiplier is **uniform** across every member of the cluster.

### Behaviour delta (the strategy change)

| Layout (same category) | Today | After |
|---|---|---|
| Isolated building | ×1.0 | ×1.0 *(same)* |
| Pair `M M` | ×1.1 each | ×1.1 each *(same)* |
| Line of 3 `M M M` | centre ×1.2, ends ×1.1 | **all ×1.2** |
| Cross of 5 | centre ×1.4, arms ×1.1 | **all ×1.4** |
| Ring of 8 around a hole | ×1.2 each | **all ×1.7** |

### Explicit edge cases (write these into tests)

- **`M E M`** (mine, electronics, mine in a line): the electronics building is a
  different category and does **not** bridge the two mines. Result: two separate
  mine-clusters of size 1 (both ×1.0) and one electronics-cluster of size 1
  (×1.0). No building gets a buff. Matches today's behaviour (the mines were never
  4-neighbours of each other).
- **Diagonal-only** (`M .` over `. M`): not 4-adjacent → two size-1 clusters →
  both ×1.0.
- **Two disjoint clusters of the same category**: each scales by its own size,
  independently.
- **Multi-tile building**: one node; a 2×2 mine touching three other mines along
  its border is in a size-4 cluster, counted once.

## Where it changes

All consumer call sites keep the current
`categoryAdjacencyMul(b, buildings, defs) → number` shape, so the rewrite is
internal. The function is **renamed** for clarity (it is no longer a per-neighbour
adjacency term):

- **`adjacency.ts`** — rename `categoryAdjacencyMul` → **`clusterBonusMul`** and
  rebuild its body to find the focal building's same-category 4-connected
  component (BFS over the border-touch graph) and apply the size formula. Add a
  batch helper **`clusterBonusMuls(buildings, defs): Map<id, number>`** that
  computes every building's multiplier in one pass (one component-labelling over
  the building set), so the per-tick hot path does not re-BFS per building.
- **`economy.ts`** — `computeRates` computes the batch map **once per call** and
  looks up the focal building's multiplier in (a) the recipe-rate buff
  (`computeBuffStack`, line ~978) and (b) the generator-power scale (line ~1198).
  `computeBuffStack` keeps its signature; its internal `categoryAdjacencyMul`
  call becomes a `clusterBonusMul` call (or a map lookup when the map is threaded
  in).
- **`inspector-ui.ts`** — single-building `clusterBonusMul` call (line ~1294);
  relabel the displayed `adjacency ×X.XX` → **`cluster ×X.XX`** (lines ~1362,
  ~1386).
- **`SPEC.md §4.5`** — rewrite the buff-adjacency paragraph: replace
  `1 + n × CATEGORY_ADJACENCY_RATE` ("distinct same-category 4-neighbours") with
  `1 + (k − 1) × CATEGORY_ADJACENCY_RATE` where `k` is the size of the focal
  building's same-category 4-connected cluster. State R1 (connectivity only, holes
  ignored). §4.4 (4-neighbor footprint set) and §5.1 (generator power reference)
  remain valid. Update any cited resolver function name from
  `categoryAdjacencyMul` to `clusterBonusMul`.
- **Tests** — `adjacency.test.ts` cluster cases rewritten (TDD): the cross-of-5
  and line-of-3 assertions flip from positional to uniform; add the `M E M`,
  diagonal, disjoint-clusters, ring-with-hole, and multi-tile cases; add coverage
  for the batch `clusterBonusMuls` agreeing with the single-building function.

## Non-goals / YAGNI

- No solid-fill or hole-penalty rule (R1 chosen).
- No change to the rate value (stays 0.10) or to `CATEGORY_ADJACENCY_RATE`'s
  shape.
- No change to gating adjacency (`checkGates`, heat, etc.) or to the exotic-pair
  skill bonus (`computeBuffStack`'s second term) — those keep direct-neighbour
  semantics.
- No cross-island lattice change: clusters are per-island physical components, as
  the category term is today.

## Testing strategy

Pure-layer unit tests only (`adjacency.test.ts`), matching the repo's
math/render split. Cover: the formula at sizes 1–9, uniformity across a cluster,
same-category-only connectivity (`M E M`), 4-adjacency-only (diagonal excluded),
disjoint clusters, ring-with-hole (R1), multi-tile single-count, rate-0 category
short-circuit, and batch-vs-single agreement.
