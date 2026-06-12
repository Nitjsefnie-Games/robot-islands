# Net-flow ⇄ power-brownout joint fixpoint — design spec

*2026-06-12. Supersedes the "next-segment re-throttle" approximation documented
in `2026-06-10-net-flow-economy-design.md:109-111`.*

## Problem

The §15.3 net-flow solver (`flow-solver.ts`) exists to kill the pre-solver
`+0/+0.0x` rate flicker: it computes a per-building gate `g ∈ [0,1]` so that a
**pinned bin runs at net exactly 0** — no cap event, no oscillation, O(1)
segments at steady state.

But `g` is solved on **nominal (gate-1) coefficients** with no knowledge of
power. Brownout (`powerFactor`) is computed *after* the solve (pass 3) and
applied in pass 4 (`economy.ts:1747`) **only to power-consuming buildings**
(`consumesPower ? powerFactor : 1`), faithful to §5.1 ("`power_factor`
multiplies the production rate of every consumer").

When a pinned resource's producers and consumers **differ in power-dependence**,
`powerFactor` scales the two sides of that bin **asymmetrically**, so the
realized net at the pinned bin is no longer 0. The bin drifts off its boundary;
the next segment's constraint set flips; `g` and `pf` swing. **The +0/+0.0x
flicker the solver was built to remove is reborn through the power side.**

The design doc that introduced the solver named this explicitly as an accepted
approximation:

> Documented approximation: `powerFactor` computed after the solve;
> brownout-reduced draw **re-throttles suppliers next segment** (clamps pin the
> bin meanwhile). **Same lag as today.**
> — `2026-06-10-net-flow-economy-design.md:109-111`

A one-segment-delayed negative-feedback loop is the textbook recipe for
oscillation. The "same lag as today" assumption was the error: the solver
removed the *storage-side* flicker but left the *power-side* lag in place,
assuming it was benign. It is not.

### Spec inconsistency (must be resolved, not just patched)

This is also a genuine internal contradiction in the locked spec:

- §15.3 (`SPEC.md:2050`): "A pinned bin runs at net **exactly 0** and therefore
  emits no cap event."
- §5.1 (`SPEC.md:607`): `power_factor` "multiplies the production rate of every
  **consumer**" — i.e. asymmetrically across a bin's participants.

Both cannot hold under active brownout. The fix resolves the spec, not only the
code.

## Core insight — a "power pool" shares one brownout scalar

Within a unified §5.3 cable component the brownout factor is a **single shared
scalar** — `min(1, producedTotal / consumedTotal)` over the component aggregate,
applied identically to every member's power-consumers
(`economy.ts:1721-1725`). It is **not** a per-island quantity needing per-island
reconciliation, so there is **no lockstep-per-segment machinery to build**.

Define a **power pool** = the set of buildings that share one brownout scalar
this tick:

- a **unified cable component** (cables pass the §5.3 gate), or
- a **single island** — when it has no cables, or its component's gate fails and
  it falls back to the local balance (`economy.ts:1726`).

Regardless of topology the fix is **one shape**: for each power pool, solve a
joint fixpoint over `(g vector, pf scalar)`:

```
pf  := the single scalar  min(1, ΣproducesW / Σ(consumesW_i × throughputFrac_i(g)))   over the pool
g   := per-building solveFlow(...) with each power-consumer's flow coefficients
       pre-scaled by pf  (so the solver balances the REALIZED, brownout-scaled flows)
iterate g ⇄ pf until both settle.
```

Because pass 4 computes `effectiveRate = base × g × pf`, pre-scaling a
power-consumer's flow coefficients by `pf` and then solving for `g` means the
solver balances exactly the flows pass 4 will realize. **Pinned bins net to 0
under the realized flows → no drift → no event → no flicker.**

`throughputFrac_i(g)` is the existing §5.1 throughput-scaled draw factor
(`effectiveMul × g × heat`), so `pf` itself stays consistent with the realized
`g`.

### Resource pooling is orthogonal

§13.3 lattice and §15.1 shared-network are **resource** coupling — they shape
the `solveFlow` *input* (the `flowSiblings` union / pooled inventory) but do not
change the power story. The same fixpoint wraps whatever flow problem they hand
it. So "everything in one pass" is **one mechanism with a wider aggregation
set**, not three separate reworks. A building's resource-flow block (solo /
lattice-union / shared-net-union) and its power pool (cable component / island)
are independent groupings that the orchestrator assembles; the fixpoint composes
over both.

## Architecture

### New pure leaf module `src/flow-power-fixpoint.ts`

Sits one level above `flow-solver.ts`. No PixiJS, no DOM, no import from
`economy.ts` (same leaf discipline as `flow-solver.ts`). Owns the `g ⇄ pf`
fixpoint and nothing else.

Responsibilities:

- Given a power pool's flow problem(s) + per-building power spec
  (`producesW`, `consumesW`, the `throughputFrac` rule) + the cap/zero
  constraints, return `{ gates, powerFactor, converged }`.
- **Iterate**: start `pf = 1` → `g = solveFlow(coeffs × pf-on-power-consumers)`
  → recompute `pf` from `g`-scaled draws → damped update → repeat until
  `‖Δg‖∞ < ε` **and** `|Δpf| < ε`, or `MAX_ITERS` is hit (then `converged =
  false` and the last iterate is returned — **fail open**, mirroring
  `flow-solver.ts`'s `FLOW_MAX_SWEEPS` + post-100 damping discipline).
- **No-brownout early-out**: if the first solve (`pf = 1`) leaves the pool at
  `ΣP ≥ ΣC`, then `pf = 1` is already the fixpoint — return after one iteration.
  So the common, non-brownout case costs **the same as today** (one `solveFlow`)
  and produces **byte-identical** gates. Only brownout-active pools pay for
  extra iterations.
- Re-use `flow-solver.ts` unchanged as the inner exact solve. This module is a
  thin damped outer loop over a low-dimensional variable (one `pf` scalar per
  pool); convergence is fast (a handful of iterations) because the `g→pf` map is
  a contraction-flavoured negative feedback (more `g` ⇒ more draw ⇒ lower `pf` ⇒
  less throughput).

The cable-component case is `N` independent per-island flow blocks (resources do
**not** cross cables) sharing **one** `pf` aggregated over the union of member
buildings; each outer iteration solves the `N` blocks against the current shared
`pf`, then re-aggregates. Solo / lattice-union / shared-net-union are a single
block.

### Wiring (callers swap `solveFlow` → the fixpoint)

1. **Solo islands** — `economy.ts computeRates` calls the fixpoint for the
   island's own power balance instead of `solveFlow`-then-separate-pass-3-`pf`.
   Passes 3/4 consume the returned `(g, pf)` — the *same* pair the solve
   balanced. Self-contained; no orchestration change.
2. **Cable components (§5.3)** — the pre-pass `computeCableNetworkBalance`
   (`main.ts:1921`) runs the fixpoint over the **union of member buildings** to
   produce the one component scalar + member gates, replacing its current
   single-shot draw estimate. `advanceIsland` for a unified-component member
   consumes that **frozen-per-tick** `pf` and the matching gates (no second
   fixpoint — the component already converged them).
3. **Lattice (§13.3) / shared-network (§15.1)** — `advanceLatticeGroup` /
   `advanceSharedNetworkGroup` swap their internal `solveFlow` for the fixpoint,
   passing the pooled (union) flow problem through unchanged, with the pool's
   `pf` (its cable component's, or the island's local).

### Convergence granularity (decided)

**Per-tick** for the cross-island component scalar: the pre-pass converges
`g ⇄ pf` once per 5 Hz tick and freezes the component `pf` for that tick's
segments. This matches the current cable-`pf` granularity and is sufficient —
the observed flicker is a per-tick (5 Hz) phenomenon, so per-tick
self-consistency removes it. (Per-segment re-convergence would require lockstep
grouped advancement of cable components and was explicitly ruled out as
invented complexity given the shared scalar.)

## SPEC.md updates

- **§15.3**: "a pinned bin runs at net exactly 0" → "...under the **realized
  (brownout-scaled)** flows." State that `g` and `powerFactor` are solved as a
  **joint per-pool fixpoint** (damped, fail-open) rather than `g`-then-`pf` with
  a next-segment lag. Remove/replace the inherited lag wording.
- **§5.1**: keep "`power_factor` multiplies the production rate of every
  consumer" — that semantic is unchanged — but note `powerFactor` is co-solved
  with the net-flow gate so the consumer-only scaling no longer breaks the
  §15.3 pinned-bin invariant. Generator wattage still never solver-gated.
- Cross-reference this doc; mark `2026-06-10-net-flow-economy-design.md:109-111`
  superseded.

## Testing

- **`flow-power-fixpoint.test.ts`** (new):
  - No brownout (`ΣP ≥ ΣC`) ⇒ one iteration, `pf = 1`, gates **identical** to
    `solveFlow` (regression guard for the common path).
  - Brownout with **asymmetric power-dependence across a pinned bin** (the bug):
    power-consuming producer + non-power consumer at a zero-pinned input; and
    power-consuming consumer + non-power producer at a cap-pinned output.
    Assert realized **net = 0** at the pinned bin under the returned `(g, pf)`.
  - Convergence: returns `converged = true` within `MAX_ITERS` for the worked
    cases; pathological non-convergence returns `converged = false` and a
    clamped `[0,1]` iterate (no NaN, no throw).
  - Property test: random pools ⇒ `pf ∈ [0,1]`, gates ∈ `[0,1]`, and every
    pinned bin nets to 0 within `ε` under the realized flows.
- **`economy.test.ts`**: steady-state-at-pinned-bin under active brownout —
  rate/`utilization` **constant across many segments**, zero oscillation
  (the direct flicker regression). Event-count: 1 h advance at a pinned bin in a
  brownout pool = **O(1)** segments.
- **`mass-balance.test.ts`**: no conjuring at a zero-pinned input and no silent
  discard at a cap-pinned output under brownout (the two bookkeeping failures
  the lag caused).
- Cross-island: a two-island cable component in brownout converges to one shared
  `pf`; member gates balance their local pinned bins under that `pf`.

## Change inventory

| File | Change |
|---|---|
| `src/flow-power-fixpoint.ts` (new) | The `g ⇄ pf` damped fixpoint; reuses `flow-solver.ts`. Pure leaf. |
| `src/flow-power-fixpoint.test.ts` (new) | Worked cases, regression guard, convergence, property test. |
| `src/economy.ts computeRates` | Solo path calls the fixpoint; pass 3/4 consume returned `(g, pf)`. |
| `src/economy.ts computeCableNetworkBalance` | Component-`pf` estimate becomes the union fixpoint. |
| `src/shared-network-advance.ts`, lattice advance | Group solves swap `solveFlow` → fixpoint. |
| `src/economy.test.ts`, `mass-balance.test.ts` | Flicker / no-conjure regression tests. |
| `SPEC.md` §15.3, §5.1 | Resolve the pinned-bin ↔ consumer-only-`pf` inconsistency per above. |

## Risk / blast radius

- Touches the hottest path (per-tick solve, all populated islands). Mitigated by
  the no-brownout early-out: only brownout-active pools iterate, and the
  iteration is a low-dimensional scalar fixpoint.
- Non-brownout results are byte-identical to today, so the bulk of the existing
  economy test corpus is an automatic regression guard.
- Convergence is bounded (`MAX_ITERS` + fail-open) so a pathological pool can
  never hang or NaN-cascade — worst case it degrades to the current
  approximation for that pool, that tick.
