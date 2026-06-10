# Net-flow economy — design spec (2026-06-10)

Agent-facing mirror of `2026-06-10-net-flow-economy-design.html` (canonical
deliverable; keep both in sync). Supersedes SPEC.md §15.3 (binary
outputAvail) and §4.7 (wall-clock wear) per owner decision.

## Problem

`outputAvail` (`economy.ts:532`) is binary per §15.3: any output bin at cap
stalls the whole building (no inputs, no outputs, no XP, no power draw). With
a live consumer on the bin the engine oscillates stall→drain→wake→refill,
producing visible +0/+0.01 rate flicker, oscillating downstream consumers
(whose `inputAvail` supply term flickers), one boundary event per segment
forever (perf), and full wall-clock wear on stalled buildings
(`economy.ts:2172`).

## Locked behavioral rules (owner decisions)

1. **Cap throttle**: producers at a full bin rescale to exactly the
   consumers' draw. Mine 5/s + workshop 3/s at cap → mine runs at u=0.6,
   bin pinned, net exactly 0. No consumer → u=0. Nothing wasted, no
   XP-at-cap farm.
2. **Min rule** (multi-output): the most-constrained output sets the whole
   building's rate. A full byproduct bin still chokes the building —
   continuously, not binary. Mass is conserved.
3. **Wear ∝ utilization**: `operatingMs` accrues × the building's
   utilization. Applies to producers and consumers alike.
4. **Input side**: already continuous (`inputAvail = supply/demand`,
   `economy.ts:575`); bin at 0, 3/s inflow, 5/s demand → consumer at 60%.
   Generalized into the same solver; stabilizes once output flicker is gone.

## Decision

Exact solve (approach B) over bounded relaxation: new pure leaf module
`flow-solver.ts` (no PixiJS, no economy.ts import — like
`vision-source.ts`). Power brownout stays OUT of the solver (one-segment
lag kept, same as today).

## Flow-solver contract

- **Inputs**: per building `i`: nominal rate (pass-1 tentative, static muls
  folded), production coeffs `p[i][r]`, consumption coeffs `c[i][r]`
  (units/sec at gate 1; exogenous-atmosphere inputs excluded). Per resource
  `r`: regime `AT_CAP` (inv ≥ cap), `AT_ZERO` (inv ≤ 0), `BUFFERED`
  (unconstrained). Regimes via existing `inv()`/`cap()` so the §13.3 Lattice
  override works.
- **Output**: gate `g[i] ∈ [0,1]` per building, replacing `ia × oa`.
- **Constraints**:
  - `AT_CAP r`: realized production ≤ realized consumption; violation ⇒
    shared throttle `θ[r] = consumption/production` over all producers of r.
  - `AT_ZERO r`: realized consumption ≤ realized production;
    `φ[r] = production/consumption` (today's inputAvail, relocated).
  - Min rule: `g[i] = min(1, min θ over capped outputs, min φ over zeroed
    inputs)`.
  - Complementarity: a constraint binds only while actually violated; the
    active set is solved consistently (deactivating constraints relax other
    producers).
  - Maximality: greatest fixed point consistent with deadlock-stays-dead.
    DAG nodes: single exact update from finalized dependencies (multipliers
    start at 1). **Inside true-cycle SCCs the start is pessimistic (0), not
    1** — (1,1) is itself a fixed point of the A↔B bootstrap deadlock, so a
    from-above start falsely self-certifies; from below, a cycle rises
    exactly when genuine external supply exists (verified: a 0.5/s external
    seed recovers (1,1)). [Corrected 2026-06-10 during Task 3 — the
    original "start g=1, monotone non-increasing" wording fails the spec's
    own deadlock example; do not "fix" the code back to it.]
  - Self-loop algebra: a building that both produces and consumes the same
    constrained resource enters that resource's equation with NET
    coefficient (p−c on the cap side, c−p on the zero side); its self-draw
    is NOT added to the target. Net≤0 participants drop out (feasible-safe,
    conservative). [Corrected 2026-06-10 during Task 3.]
- **Algorithm**: graph over constrained resources only → SCC condensation →
  topological order; exact propagation through the DAG; inside an SCC,
  damped iteration to ε = 1e-9 with hard iteration guard. Deterministic.
- Rare-find trickles stay outside the solver, clamp-pinned by `applyRates`
  as today (cap overflow of a bonus trickle vanishes — unchanged behavior).
- **Furnace coal burn — cap-side demand (owner decision 2026-06-10):** the
  §5.2 coal burn (`coalPerCycle × servedCount / 30s`, folded into
  `net.coal` post-recipe at `economy.ts:1497-1508`) IS solver-visible on
  the cap side: each billing furnace appends a synthetic consumer entry
  `{ consumes: { coal: burnPerSec } }` so a coal producer at a pinned coal
  bin throttles to recipe-draw + burn (otherwise the cap flicker loop
  returns for coal specifically). The synthetic entries are SKIPPED when
  coal is zero-constrained: the existing binary fuel-starvation recompute
  (Fix 4.1, `economy.ts:1510-1546`) owns that regime per §5.2's
  all-or-none heat gate; proportional fuel/heat is explicitly deferred.

### Worked examples (= unit tests)

1. Cap throttle: iron AT_CAP, mine 5/s, workshop 3/s → θ=3/5, g(mine)=0.6.
2. Zero flow-through: iron AT_ZERO, mine 3/s, workshop demand 5/s → φ=3/5,
   g(workshop)=0.6.
3. Min rule: alloy AT_CAP (small draw) + slag BUFFERED, one building → g =
   θ[alloy]; slag slows too.
4. Deactivating constraint: building outputs r1 (AT_CAP, demand 2/s of
   10/s) and r2 (AT_CAP, demand 0) → g=0 via θ[r2]; r1 then drains and its
   constraint deactivates; solution stays g=0 (r2 binds). With r2 demand
   5/s: g = min(0.2, 0.5) = 0.2; r2 drains, deactivates; r1 binds at 0.2.

## computeRates integration (four-pass shape survives)

- Pass 1: unchanged; also assembles solver coefficients.
- Pass 2: replaced by `solveFlow(...) → g[i]`. Audit every
  `outputAvail`/`inputAvail` call site (findReferences) before removing.
- Pass 3: `nominalThroughputFrac = gates × g[i] × heat` (power draw
  rescaling falls out of existing §5.1 throughput-scaled draw).
- Pass 4: `effectiveRate = baseRate × g[i] × pf × accel × variance ×
  perBuildingMul`. `BuildingRate` gains `utilization`.
- Documented approximation: `powerFactor` computed after the solve;
  brownout-reduced draw re-throttles suppliers next segment (clamps pin the
  bin meanwhile). Same lag as today.

## Wear, XP, events

- `accrueOperatingTime(b, dtMs × u)`. `u` is defined BY EXCLUSION so it
  stays precise wherever individual factors are folded: the product of
  every dynamic gate composed into the building's `effectiveRate` (solver
  gate `g[i]`, `powerFactor` for consumers, heat throttle, adjacency-gate
  muls) EXCLUDING maintenanceFactor (no degradation-slows-degradation
  feedback), time-acceleration, variance, and static per-building yield
  multipliers. Same building filters as
  today. The `economy.ts:1270` comment ("can't escape maintenance by
  capping output") is explicitly superseded.
- XP: no new code — accrues from pass-4 production, which carries the
  throttle.
- Events: piecewise-constant invariant preserved; pinned bins have net 0 ⇒
  no events. Maintenance boundary candidate becomes
  `tMs + (boundary − operating) / u` (skip at u=0); u is segment-constant
  so the mapping is exact.
- Persistence: NO schema bump; `operatingMs` semantics unchanged
  (accumulated wear-ms), v22 stays.

## Change inventory

| File | Change |
|---|---|
| `src/flow-solver.ts` (new) | Exact solver, pure leaf module. |
| `src/flow-solver.test.ts` (new) | Worked examples, chains, cycles, deactivating constraints, randomized property test (AT_CAP ⇒ prod≤cons; AT_ZERO ⇒ cons≤prod; maximality). |
| `src/economy.ts` computeRates | Solver wiring per above; `BuildingRate.utilization`. |
| `src/economy.ts` advanceIsland | `accrueOperatingTime(b, dtMs × u)`. |
| `src/economy.ts` findNextCapEvent | Maintenance boundary `/u`. |
| `src/maintenance.ts` | Doc comments only (RAMP sub-segmentation is in operatingMs space, survives unchanged). |
| `src/economy.test.ts` + audit `mass-balance.test.ts` | Behavioral tests below; binary-stall assertions flipped individually against this spec. |
| `SPEC.md` §15.3/§4.7/§5.1 | Supersession per table below. |

## SPEC.md updates

- §15.3: binary outputAvail → continuous demand-coupled throttle (shared θ
  per resource, min rule, exact active-set solve); piecewise-constant-rate
  invariant explicitly preserved.
- §4.7: wear accrues in utilization-scaled operating time; thresholds,
  ramp, recipes unchanged.
- §5.1: throughput-scaled draw factor renamed to solver gate g; extremes
  identical.

## Verification

- Solver unit tests (above).
- Steady state at cap: u stays 0.6 across many segments, bin pinned, XP
  0.6×, draw 0.6×, zero oscillation.
- Event-count regression: 1 h advance at pinned cap = O(1) segments.
- Offline ≡ online: 24 h single catchup ≈ 24 h of small ticks (existing
  invariant re-asserted).
- Wear: u=0.5 for 2 h → 1 h operatingMs; u=0 → none; boundary event lands
  at stretched time; degraded building wears at duty-cycle speed (not
  × maintenanceFactor).
- `mass-balance.test.ts` passes unmodified.
- `npm test` green; `npm run build` clean; Daedalus screenshot shows steady
  inspector rates on a capped chain.

## Risks

- Active-set solver bug (HIGH): pure module + property tests + iteration
  guards + applyRates clamps.
- Balance shift from slower wear / throttled XP (MED): intended; thresholds
  remain knobs.
- Test-flip masking regressions (MED): each flipped assertion reviewed;
  mass-balance + offline-equivalence non-negotiable.
- Brownout × throttle lag (LOW): exists today; documented.

## Out of scope

Power as a solver commodity; UI utilization badge (BuildingRate.utilization
makes it trivial later); maintenance threshold retuning; proportional
fuel/heat (continuous furnace starvation — would rewrite §5.2's all-or-none
heat gate; cap-side burn demand ships now, this follow-up is deliberate).
