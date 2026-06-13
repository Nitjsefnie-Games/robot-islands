# Force-Run toggle — produce-at-cap for XP

**Date:** 2026-06-13
**Status:** Design approved, pending implementation plan
**Scope:** Single mechanic — a per-building inspector toggle that keeps a
building running (earning XP) when its output bin is full, instead of
throttling to zero.

## Problem

Under the net-flow economy (§4.6, §15.3), when a building's output resource
hits its storage cap the flow solver drives that building's gate `g → 0`: it
stops producing, earns no XP, and accrues no maintenance wear. This is the
correct default — it stops waste. But a player who wants to keep levelling an
island past the point where its storage is full has no way to convert a
maxed-out, otherwise-idle production line into XP.

## Goal

Add a per-building **Force Run** toggle. When **on**, the building keeps
running even with a full output bin. It genuinely operates — it consumes its
inputs, draws power, and accrues maintenance wear — and the overflow output is
voided at the cap (caps stay hard). The XP is the payoff; the inputs, power,
and wear are the cost. A real tradeoff, not a free XP faucet.

## Key insight — the integrator already supports this

The event-driven piecewise integrator already does the hard part. The only
behavioral change needed is in the flow solver.

- **Overflow is auto-voided.** `applyRates` clamps every inventory to
  `[0, cap]` (`economy.ts:2147`). A force-run producer's net-positive flow
  into an already-full bin is clamped at the cap each segment — the excess is
  discarded, no special handling.
- **No infinite loop.** `findNextCapEvent` skips emitting a boundary event for
  a bin that is at/over cap with positive net flow (`economy.ts:2068`,
  `headroom <= 0 ⇒ continue`). The clamp pins the bin at cap; the next pass
  sees no recurring event.
- **XP and wear follow automatically.** XP accrues from production
  (`accrueXp`, weighted by `effectiveRate`); wear accrues as
  `dt × utilization`. Both are nonzero exactly when `effectiveRate > 0`. Once
  the solver lets the gate stay open, XP and wear come for free.

So the single behavioral change: a force-run building must be **excluded from
the `cap:r` constraint** in the flow solver, so its gate isn't dragged to 0 by
a full output bin.

## Components / changes

### 1. `buildings.ts` — the per-building flag
Add an optional field to `PlacedBuilding`:

```ts
/** Force-run: keep producing for XP even when an output bin is at cap.
 *  Absent / false = default (throttle to consumer draw at a full bin).
 *  The building still consumes inputs + power and accrues wear; overflow
 *  output is voided at the cap. */
forceRun?: boolean;
```

Absent = off = exactly today's behavior.

### 2. `flow-solver.ts` — exclude force-run from the cap constraint
`FlowBuildingSpec` gains an optional `ignoreOutputCap?: boolean`. When set:

- **Key assignment:** do not assign that building any `cap:r` key (skip the
  loop that pushes `cap:${r}` for capped outputs).
- **Constraint accounting:** inside `update('cap:r')`, skip that building from
  both the producer `entries` and the consumer `target` accumulation, so the
  shared multiplier θ for resource `r` governs only the non-force-run
  producers. They still solve to match live consumer draw; the force-run
  building runs outside the cap mechanism entirely and voids its overflow.

The `zeroConstrained` (input-empty) constraint and the power factor are
**unchanged** — a force-run building still stops when starved of inputs and
still scales with brownout. Inputs and power stay real costs.

### 3. `economy.ts` — pass the flag through
In `buildFlowBuildings`, set `ignoreOutputCap: b.forceRun` on each spec.
Nothing else changes — XP, wear, and the cap clamp all flow from existing
code.

### 4. `inspector-ui.ts` — the toggle button
A toggle button in the maintenance section, alongside the floor-disable
steppers, reusing the existing pattern:

- `makeExpandButton()` styling (the dominant action-button style).
- A module-scoped `pendingForceRun` + a `defineAction(reg, 'toggle-force-run', …)`
  that reads the pending value, calls `deps.onSetForceRun(target, value)`, and
  calls `paint()`.
- Label reflects state: **"Force Run: Off"** / **"Force Run: On"** (accent-lit
  when on).
- **Shown only for buildings with a productive resource output** — the only
  buildings a storage cap can throttle (matches the §4.7 maintenance scope:
  storage / power / logistics / antenna / drone-pad buildings don't qualify).
  Hidden while under construction.

### 5. `main.ts` — wire the callback
Add `onSetForceRun(target, value)` to the inspector deps: set
`building.forceRun = value || undefined` (store `undefined` when off to keep
saves clean) and trigger the same save path `onSetActiveFloors` uses.

### 6. `persistence.ts` — additive, no bump expected
`forceRun` is a purely additive optional boolean. It round-trips through the
existing `buildings` spread in serialize/deserialize (like `disabledFloors`,
`cargoLabel`). Old saves load with `forceRun` absent = off — identical
behavior. **No schema bump expected.** Confirm during implementation that no
strict-shape validation rejects the new field; add a no-op migration only if
the persistence layer requires it.

### 7. `SPEC.md` — keep code and spec in sync
- **§4.6** (the cap-throttle paragraph): add the Force-Run override — when a
  building has Force Run on, it is exempt from the `r`-at-cap throttle, keeps
  running at its input/power/heat/adjacency-gated rate, voids the overflow at
  the cap, and earns XP from the voided production.
- **§4.7** (maintenance): caveat that a force-run building does **not** escape
  maintenance the way an idle capped building does — it keeps a nonzero duty
  cycle and therefore wears normally. This is the intended cost.

## Testing

- **flow-solver:** a force-run producer keeps gate `> 0` at a capped output
  while a normal producer of the same capped resource gates to 0; the
  non-force-run producers still solve to consumer draw.
- **economy:** with Force Run on at a full output bin — XP accrues, overflow
  is voided (inventory stays exactly at cap), wear accrues, inputs are still
  consumed, and the building still stops when its inputs run dry.
- **persistence:** a building with `forceRun: true` round-trips identity; a
  legacy save (field absent) loads with Force Run off.

## Out of scope

- No global / multi-building Force Run control — per-building only, matching
  the "a button" request and the floor-disable precedent.
- Force Run does not let output exceed cap — overflow is always voided.
- No new XP-only code path — XP comes from genuine (then-voided) production.
