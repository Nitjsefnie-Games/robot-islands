# Cluster Bonus — Floor-Weighted Capacity — Design

**Date:** 2026-06-12
**Status:** approved (brainstormed with user; numbers-validated)
**SPEC.md anchor:** §4.5 Adjacency Effects (buff-adjacency paragraph rewrite)

## Problem / intent

The §4.5 cluster bonus and the floor-upgrade mechanic are in tension, and
the cluster bonus is too strong. Both symptoms trace to one root cause:
**cluster size `k` is a raw building head-count** (`adjacency.ts`
`clusterBonusMuls` increments `compSize` by 1 per building, blind to
`floorLevel`), then every member gets `1 + (k − 1) × rate`.

Consequences, confirmed numerically:

1. **Floors aren't rewarded.** A floor-10 building (×10 output, 1 tile)
   contributes the same `+1` to `k` as a floor-1 shack, and going tall to
   save space *shrinks* head-count, *shrinking* the bonus. Marginal
   analysis ("add a base building vs upgrade one", Δoutput per Δmaterial,
   at any cluster size) shows **adding wide always beats upgrading** under
   the current rule. Floor upgrades are the worst material-efficiency
   option on the board — a space-only fallback.

2. **Cluster is too strong.** `1 + (k − 1) × 0.10` is uncapped and grows
   without limit in head-count: a k=9 spam-cluster already gives every
   building ×1.8 and keeps climbing.

## Decision summary (user-confirmed)

| Question | Decision |
|-|-|
| Target relationship | **Favor tall** — floor-upgrading is the better long-term investment; wide is the early/cheap option |
| Magnitude shape | **Linear, uncapped, lower rate** (no hard cap, no diminishing curve) |
| Self-bonus | **Neighbors only** — a building's bonus comes from *other* buildings' floor-capacity; its own height drives only its own floor multiplier |

## The model

Building *i*'s cluster multiplier becomes:

```
mul_i = 1 + r · (K − c_i)
  where  c_i = 1 + floorLevel_i          (== floorEffectMul, the building's own capacity)
         K   = Σ_j c_j  over the same-category 4-connected component
         r   = CATEGORY_ADJACENCY_RATE[category]   (0.10 → 0.05)
```

(Was `1 + (k − 1) · r` with `k` = head-count.) Linear, uncapped,
**excludes the building's own capacity** from its own bonus. Applies to
recipe rate and generator power **output** exactly as today; power
**consumption** still excluded. The §4.4 connectivity/component definition
is unchanged — only the size→multiplier step changes.

### Key property: floor-1 baseline is unchanged except for the rate

When every building in a component is floor-1, `c_j = 1` for all `j`, so
`K − c_i = (k − 1)` and the formula collapses to `1 + (k − 1) · r` — the
old formula. The *only* behavioral change at the all-floor-1 baseline is
the rate cut 0.10 → 0.05. Divergence from old behavior appears strictly
once floors > 1 exist in a cluster.

### Rate

`CATEGORY_ADJACENCY_RATE` seeded **0.10 → 0.05**, all categories. The
per-category table structure is retained for future per-category tuning.
Storage / logistics / cooling stay no-ops (no recipe, no power output).

## Validated numbers (P=1 placement, upgrade = 0.8·P/floor, 1 tile/bldg, consumer draw = 1+0.5L)

Throughput (`out`) at the chosen model, r=0.05, vs current rule:

| Scenario | CUR out | new out | new /tile | new /mat |
|-|-|-|-|-|
| 4× floor-1 (k4) | 5.20 | 4.60 | 1.15 | 1.15 |
| 1× floor-4 lone | 4.00 | **4.00** | 4.00 | 1.18 |
| floor-4 + 3× floor-1 (k4) | 9.10 | 8.50 | 2.13 | 1.33 |
| 4× floor-4 (k4) | 20.80 | **25.60** | 6.40 | 1.88 |
| 1× floor-10 lone | 10.00 | **10.00** | 10.00 | 1.22 |
| 9× floor-1 (k9) | 16.20 | **12.60** | 1.40 | 1.40 |

- Lone tall buildings are **identical to today** (no self-bonus): floor-4
  lone = 4.0, floor-10 lone = 10.0.
- Wide spam is **tamed**: k=9 drops 16.2 → 12.6; k=4 drops 5.2 → 4.6.
- Clustered tall is **rewarded**: 4× floor-4 rises 20.8 → 25.6 (+23%); its
  material efficiency 1.53 → 1.88.

Marginal "add wide vs upgrade", per material, at r=0.05:

| k | add-wide /mat | upgrade /mat | winner |
|-|-|-|-|
| 2 | 1.200 | 1.375 | UPGRADE |
| 4 | 1.400 | 1.625 | UPGRADE |
| 10 | 2.000 | 2.375 | UPGRADE |
| 20 | 3.000 | 3.625 | UPGRADE |

Upgrade wins on material at **every** cluster size, and costs **0 tiles** —
satisfying "favor tall." Raw Δoutput still slightly favors add-wide (e.g.
k=4: add Δ1.40 vs upgrade Δ1.30), so wide remains a valid "max output if
you have spare space + materials" play — no single-strategy degeneracy.
Wide also keeps its non-throughput edges: parallel build slots, no
upgrade-construction downtime, spreading load across power networks.

## Scope of change

- **`src/adjacency.ts`** — `clusterBonusMuls`: keep the union-find
  component labelling; replace the size→multiplier step. Compute per
  component the floor-weighted capacity `K = Σ (1 + floorLevel)` over its
  members, then set each member's value to `1 + r · (K − (1 + floorLevel_i))`.
  The returned `Map<string, number>` already carries per-building values,
  so consumers (`computeBuffStack`, the generator-power path in
  `economy.ts`) need no signature change. `clusterBonusMul` (single-building
  wrapper) is unchanged in signature.
  - Note: `floorLevel` must be read via the existing `floorLevel(b)` helper
    (clamped `[0,9]`, undefined-safe) so legacy/un-upgraded buildings read
    as `c = 1`.
- **`src/building-defs.ts`** — `CATEGORY_ADJACENCY_RATE` values 0.10 → 0.05.
- **`SPEC.md §4.5`** — rewrite the buff-adjacency paragraph: drop "uniform
  across every member of a cluster" (now per-building by floor); state the
  floor-weighted neighbor-capacity formula and the new 0.05 seed; note the
  floor-1 baseline collapses to the old form.
- **No persistence change** — the cluster bonus is computed live each tick;
  `floorLevel` is already persisted. No schema bump, no migration.

## Test plan

- **`src/adjacency.test.ts`**
  - Floor-1 baseline parity: an all-floor-1 cluster of size `k` yields
    `1 + (k − 1) · 0.05` for every member (collapse property).
  - Per-building/floor: in a mixed cluster, each member's multiplier
    excludes its own `1 + floorLevel`; a taller neighbor raises *others'*
    multipliers but not its own self-term.
  - No self-bonus: a lone building (any floor) → multiplier 1.0.
  - Rate-0 / no-op categories still return 1.0.
  - Generator-power path: confirm the per-building cluster mul flows into
    `economy.ts` power output (not consumption) for clustered generators.
- **Economy / power tests** asserting the old `1 + (k−1)·0.10` numbers:
  update expected values to the 0.05-rate, floor-weighted results.
- Full `npm run build` + `vitest run` green.

## Out of scope

- No cap or diminishing curve (explicitly rejected — linear/uncapped chosen).
- No change to upgrade cost / time / power-draw scaling.
- No per-category rate differentiation yet (all 0.05; table kept for later).
