# Global CO₂ Atmosphere — Design

**Date:** 2026-06-19
**Status:** Approved, ready for plan
**Topic:** Make the CO₂ climate model a single global pool (not per-island), so any
sink (trees, scrubbers) drains the world-wide total and can offset emissions from
other islands.

## Problem

The spec already describes CO₂ as "the single global atmosphere" (§2.6 implementation
note, §15.3 NON_STORED_OUTPUTS note), but the **implementation is per-island**:

- Each island accrues emissions to its own `state.co2Kg` scalar.
- Sinks (`plant_a_tree`, `exhaust_scrubber`, anything with `co2CaptureKgPerCycle`)
  drain **the same island's** `state.co2Kg`, floored at 0 (`economy.ts` ~2473:
  `state.co2Kg = Math.max(0, state.co2Kg - drainKg)`).
- The world total consumed by weather is `sumIslandCo2(world) = Σ state.co2Kg`
  (`weather.ts`), read by weather, drones, routes, settlement, HUD, overlays, tutorial.

Consequences the player hits:

1. Capture on island A **cannot** offset emissions on island B — each island floors at 0
   independently, so a forest island carpeted in trees can only zero out its own
   emissions; capture past that is wasted.
2. "One island offsets the entire world" is impossible under this model, even though the
   spec's conceptual framing ("single global atmosphere") promises it.

`world.totalCo2Kg` exists as a field (`world.ts:816`, serialized in `persistence.ts`) but
is **vestigial** — initialized to 0, never written after init, never read by any climate
path.

## Goal

Make CO₂ a single global pool. Emissions add to it; every sink drains it (floored at 0
globally); weather reads it. A forest island's trees then drive the **world** total down
and hold it at 0, offsetting every other island's emissions. This aligns the
implementation with the spec's already-stated conceptual model.

## Design

### 1. Single global pool

`world.totalCo2Kg` becomes the authoritative global scalar (no longer vestigial).
`sumIslandCo2(world)` — the stable read API — changes its **internals** to return
`world.totalCo2Kg`. All ~10 read call sites (weather sampling in `economy.ts`,
`drones.ts`, `routes.ts`, `settlement.ts`, `weather-overlay.ts`, `hover-tooltip.ts`,
`hud.ts`, `tutorial.ts`) are untouched — the function name and signature are preserved.

### 2. Threading the pool into the integrator

`RatesContext` gains an optional mutable holder `co2Pool?: { kg: number }`.

The CO₂ accrual/drain lives in `applySegmentSideEffects` (called per-segment by `advanceIsland`),
which already receives `ctx`. Each of the three mutation sites (recipe-output emission, exogenous
fuel-combustion emission, sink drain) branches on `ctx?.co2Pool`:

```ts
const pool = ctx?.co2Pool;
// emission:  if (pool) pool.kg += emit;        else state.co2Kg += emit;
// drain:     if (pool) pool.kg = Math.max(0, pool.kg - drainKg);
//            else      state.co2Kg = Math.max(0, state.co2Kg - drainKg);
```

- When the **world driver** supplies a shared `co2Pool`, accrual/drain is global and
  `state.co2Kg` is left untouched (inert in production).
- When `advanceIsland` is called **standalone** (isolated unit tests, embedding) with no
  pool, the holder is seeded from and written back to `state.co2Kg` — preserving existing
  per-island unit-test semantics.

`advanceWorldEconomy` constructs **one** holder `const co2Pool = { kg: world.totalCo2Kg }`,
passes it via `ctx.co2Pool` on every per-island `advanceIsland` call, then writes
`world.totalCo2Kg = co2Pool.kg` once the loop completes. Production is therefore always global.

**Scope note — grouped advance paths stay CO₂-inert.** The grouped lattice (`advanceLatticeGroup`)
and shared-network (`advanceSharedNetworkGroup`) paths reimplement the integration loop inline and
**do not accrue or drain CO₂ at all today** — verified by grep (`co2`/`exogenousFlow`/`biogenic`/
`CaptureKg` absent from both files). That is pre-existing behavior, not introduced here. This change
threads the global pool only into the per-island `advanceIsland` path; islands advancing under a
lattice or cross-island shared network remain CO₂-inert exactly as before. Wiring CO₂ into the
grouped loops is a separate follow-up, out of scope.

### 3. Sinks eat from global (plant_a_tree included)

No change to the sink loop's shape. It already drains `co2CaptureKgPerCycle × cyclesThisSegment`.
It now drains the **shared pool**, floored at 0. So a forest carpet of upgraded trees drives
the world total toward 0 and holds it there — the requested behavior, falling straight out of
§1–§2. `plant_a_tree` is recipe-backed (`cycleSec 60`), so its `effectiveRate` (and thus drain)
already scales with floor; that is unchanged.

### 4. Floor at 0

The global pool clamps at 0 kg (matching the spec's "atmosphere" framing; weather severity
bands start at <100 kg). Excess capture past 0 is wasted — no carbon-negative banking.

### 5. Persistence migration v26 → v27

(Current `SCHEMA_VERSION = 26`; `totalCo2Kg` has been a serialized world field since the
v14→v15 migration, but every save to date has it at 0 with the real climate pressure living
in per-island `co2Kg`.) The migration seeds the global pool from the old sum:

```
world.totalCo2Kg = (existing world.totalCo2Kg) + Σ islandStates[*].state.co2Kg
```

Per-island `co2Kg` is retained in the `IslandState` type (it still serves the standalone
advanceIsland path) but is inert in production. Follows AGENTS.md bump=migrate discipline:
add `SerializedSnapshotV26` alias, `migrateV26toV27`, bump `SCHEMA_VERSION` to 27, wire into
`loadWorld`'s dispatch chain, add 27 to `SUPPORTED_LOAD_VERSIONS`.

### 6. SPEC.md (same change)

Update in lockstep:

- §2.6 implementation note ("CO₂-driven storm amplification") — rewrite from
  "Each island accumulates `co2Kg` … `sumIslandCo2` totals it" to "the world maintains a
  single `totalCo2Kg`; emissions add to it and sinks drain it (floored at 0) across all
  islands."
- §15.3 NON_STORED_OUTPUTS note — rewrite the `(2) co2` paragraph from "accrues only to the
  per-island `co2Kg` scalar … world total is `Σ co2Kg`" to the single-global-pool model.

### 7. Server

Rides along unchanged. `server/src/game/runtime.ts` reuses the pure layer
(`advanceWorldEconomy`) and `serializeWorld`/`deserializeWorld`. The global field and the
v16 migration round-trip through the existing persistence path; there is no separate server
CO₂ code.

## Known simplification (documented, not a bug)

In a long **offline** catch-up, islands advance sequentially against the shared pool, so the
global floor-at-0 is mildly order-dependent (an all-trees island processed first may clamp to
0 before a later emitter adds to the pool). Live (200 ms ticks via `economy-clock.ts`) the per-
tick window is tiny and interleaves finely — sub-kg — which is exactly the regime where "one
forest offsets the world" must work, and it does. This matches the approximation class the
integrator already tolerates and is strictly better than today's fully-wasted cross-island
capture.

## Testing

- `sumIslandCo2`-based tests pass unchanged (read API preserved).
- Standalone `advanceIsland` `co2Kg` assertions pass via the fallback path.
- **New:** cross-island offset — an emitter island + a forest island with enough tree capture
  drive `world.totalCo2Kg` (via `advanceWorldEconomy`) toward 0; with capture ≥ emission it
  holds at 0.
- **New:** global floor — capture beyond total emissions does not push the pool below 0.
- **New:** v15 → v16 migration seeds `world.totalCo2Kg = Σ co2Kg`; v16 round-trips identity.

## Files touched

- `src/economy.ts` — `RatesContext.co2Pool`, holder logic in `advanceIsland`, world driver
  threads the shared pool.
- `src/weather.ts` — `sumIslandCo2` reads `world.totalCo2Kg`.
- `src/persistence.ts` — v15→v16 migration, `SUPPORTED_LOAD_VERSIONS`.
- `SPEC.md` — §2.6 and §15.3 notes.
- Tests: `economy.test.ts` / a new `co2.test.ts`, `persistence.test.ts`.
- No server-code changes (rides the pure layer).
