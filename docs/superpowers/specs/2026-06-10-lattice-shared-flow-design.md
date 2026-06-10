# Lattice shared-flow — design spec (2026-06-10)

Agent-facing canonical doc (HTML mirror published to docs-hub under the
same slug stem). Closes bug-sweep deferred item **D-01: Lattice unified
pool never drains partner islands — matter from nothing**. Design locked
by the owner in-session 2026-06-10; supersedes the §13.3 "eligibility
reads the pool, decrement stays local" implementation.

## Problem

With the Omniscient Lattice active, member islands' economy reads
(`inputAvail` stockpile checks, `cap()`) use the unified pool via the
`ctx.inventory`/`ctx.caps` overrides — but `applyRates` decrements ONLY
the local island's inventory, clamped at 0. A member island with zero
local stock of an input runs forever off a partner's stock that never
shrinks. Matter from nothing; also exactly the value-fabrication class
the future server-authoritative migration exists to prevent.

## Locked design — one flow problem per lattice component

1. **Union solve.** When the Lattice is active, the member islands'
   buildings form ONE net-flow problem: `computeRates`' pass 2.5 feeds
   the solver the union of all members' flow coefficients (same
   `FlowBuildingSpec` shape, building→island ownership tracked by
   index). Cap/zero regimes are computed from **pooled inventory vs
   pooled caps** (`Σ` member inventories / `Σ` member caps per
   resource). Producers and consumers across islands throttle against
   each other with the exact same shared-θ/φ + min-rule semantics as
   same-island flows. Mass conserved by construction — no drain pass.
2. **Cap-proportional distribution.** Pooled stock has no abstract
   home: after each integrated segment the pooled quantity of each
   resource is written back to member inventories as
   `local_i = pooled × cap_i / Σcaps` (resources where `Σcaps = 0`
   keep their local stocks untouched). Properties that fall out free:
   - `pooled ≤ Σcaps ⟹ local_i ≤ cap_i` — every slice fits its
     island's cap automatically.
   - **Persistence unchanged** — saves already store per-island
     inventories; they are simply the distributed representation. No
     schema bump.
   - **Deactivation is clean** — when the Lattice gate drops, every
     island keeps its current share; nothing to unwind.
3. **Lockstep advance.** Members integrate together: one segment
   timeline for the component, `findNextCapEvent` evaluated over the
   POOLED inventories (plus each member's own maintenance/construction
   boundaries — take the min across members). `advanceIsland`'s caller
   groups lattice members and advances the group to `nowMs` as a unit;
   non-members advance per-island exactly as today.
4. **Per-island attribution unchanged.** XP accrues on the island
   whose building produced; wear (`utilization`) and maintenance
   billing stay per-building/per-island; power stays on the existing
   pass-3 cable-component model (which is the philosophical precedent:
   one balance across a component — this design extends the same idea
   to resources).

## Implementation notes

- The flow solver (src/flow-solver.ts) needs NO changes — it is
  building-set agnostic. The work is in economy.ts's pass-2.5 input
  assembly (union + pooled regimes), applyRates-equivalent pooled
  accounting + distribution, findNextCapEvent's pooled view, and the
  grouped-advance orchestration in advanceIsland's caller (main.ts
  advanceEconomy + offline catchup path).
- The DerivationsMemo stays per-island (adjacency/skill derivations are
  island-local; cross-island gate adjacency already flows through
  ctx.crossIsland and is in the memo signature).
- Heat, solar, variance, acceleration remain per-island multipliers in
  pass 1/4 — they shape each island's coefficients before the union.
- Synthetic furnace coal entries: per-island as today; they join the
  union like any other entry.
- The §13.3 retroactive sections of SPEC.md gain the pooled-flow +
  cap-proportional-distribution semantics; the "unified-inventory pool"
  wording stays, now with conservation.

## Tests (minimum)

- Two-island lattice, consumer on A with zero local stock, producer
  stock on B: running A's consumer DRAINS the pool and B's
  redistributed share shrinks — total mass conserved to 1e-9 across a
  long advance (the D-01 regression).
- Cap-proportional distribution: pooled stock redistributes by cap
  share; an island with cap 0 for r holds 0 of r (unless Σcaps=0
  freeze case).
- Producer on A at pooled cap with consumer on B: cross-island throttle
  θ matches the same-island case (solver-union equivalence).
- Deactivation mid-state: shares freeze, per-island advance resumes,
  suite invariants (mass-balance, offline≡online) hold.
- Lockstep: group advance ≡ the same scenario advanced in one island
  when all buildings are colocated (equivalence anchor).

## Risks

- Grouped advance is the structural change (advanceIsland's loop
  contract) — keep non-lattice path byte-identical; lattice path gated
  on `latticeActive`.
- Offline catchup with lattice active must use the grouped path too,
  or the pool desyncs (HIGH if missed — add an explicit test).
- Distribution rounding: use exact proportional floats; clamp guards
  stay as defense-in-depth.

## Out of scope

Proportional fuel/heat (separate deferred item); server-side ownership
of the pool (the migration inherits this design unchanged — the lattice
component becomes a server-side grouping key).
