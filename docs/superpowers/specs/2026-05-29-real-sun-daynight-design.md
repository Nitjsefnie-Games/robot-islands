# Real-sun day-night cycle — design

**Date:** 2026-05-29
**Status:** approved (brainstorming) → ready for implementation plan
**Reported bug:** At 21:43 local time in Brno (in-game location), the HUD showed
`Dawn 78% · solar 0.0×` — a fake "Dawn" label sitting next to the real sun's
zero output.

## 1. Problem & root cause

Two independent clocks coexist in the codebase:

1. **Real astronomy** — `solarMultiplier(now, lat, lon)` in `daynight.ts` uses
   `SunCalc.getPosition` at the player's coordinates and returns
   `sin(altitude)` (0 below horizon). This already drives solar **power
   output**. It is correct and location-aware.

2. **Synthetic clock** — `dayPhase(now)` / `dayPhaseName(now)` map wall-clock
   *Unix-epoch* time through a fixed `EPOCH_PHASE_OFFSET = 0.375` into four
   equal 6-hour quadrants (Dawn/Day/Dusk/Night). It has **no connection to the
   player's location**.

The HUD label, the screen tint, weather modulation, a "during-night" gameplay
gate, and the economy integrator's segment boundaries all read the **synthetic**
clock. Numeric confirmation: at 19:43 UTC (= 21:43 CEST Brno),
`(19.717/24 + 0.375) mod 1 = 0.1965` → quadrant `dawn`, fraction
`(0.1965×4) mod 1 = 0.786` → **"Dawn 78%"**, exactly as reported, while the real
sun was below the horizon (`solar 0.0×`).

**Scope (user-chosen):** migrate the behavioral consumers to the real sun
(cosmetic **and** gameplay). Do **not** delete the synthetic helpers — they are
repurposed as the no-location fallback (§4).

## 2. Approach: add real-sun functions, switch consumers, keep synthetic as fallback

Rather than rewrite the synthetic helpers (which have a dedicated, passing test
suite in `daynight.test.ts`, e.g. the `nextPhaseBoundaryMs` quadrant-boundary
assertions), we **add** real-sun functions alongside them and switch each
consumer to call the new function with the player's coordinates. The synthetic
functions remain defined and tested, and are invoked as the deterministic
fallback when no location is set.

This keeps the blast radius minimal: existing tests that exercise the synthetic
path (including all of `weather.test.ts`, which never passes coordinates) stay
green unchanged.

## 3. New pure functions in `daynight.ts`

All take `(nowMs, lat: number | null, lon: number | null)` and are PixiJS/DOM-free.

### 3.1 `realPhaseName(nowMs, lat, lon): DayPhase` — altitude-based, NaN-free

```
if lat == null || lon == null → return dayPhaseName(nowMs)   // synthetic fallback
h       = SunCalc.getPosition(nowMs, lat, lon).altitude       // radians
rising  = SunCalc.getPosition(nowMs + 60_000, lat, lon).altitude > h
CIVIL   = -6° in radians (-0.10472)
  h >= 0                          → 'day'
  h >= CIVIL && rising            → 'dawn'
  h >= CIVIL && !rising           → 'dusk'
  h <  CIVIL                      → 'night'
```

- Geometric horizon (`h = 0`) is the sunrise/sunset boundary; civil twilight
  (`h = -6°`) bounds the dawn/dusk bands. These are the intuitive
  "the sun is up" / "it's getting dark" thresholds (user-approved).
- `getPosition` never returns NaN, so polar night → never `'day'`, midnight sun
  → always `'day'`; both astronomically correct, no special-casing needed.

### 3.2 `nextSunEvent(nowMs, lat, lon): { kind: 'sunrise' | 'sunset'; atMs: number } | null`

Used by the HUD countdown **and** the integrator boundary (§5). Uses
`SunCalc.getTimes` for the day of `nowMs` and the following day, collects the
`sunrise`/`sunset` timestamps, and returns the earliest strictly after `nowMs`
together with its `kind`.

- The earliest future event's `kind` is automatically the meaningful one: when
  the sun is up the next crossing is necessarily a `sunset`; when it is down,
  a `sunrise`. The HUD displays `${kind} in ${atMs − now}` directly — no
  separate altitude check needed.
- Returns `null` when `lat`/`lon` are null **or** when `getTimes` yields no
  valid sunrise/sunset (polar day/night → `Invalid Date` → `NaN` guarded).

### 3.3 `nextRealPhaseBoundaryMs(nowMs, lat, lon): number`

The earliest of the four real phase transitions strictly after `nowMs`, from
`getTimes` over today+tomorrow:

- `sunrise` (h=0 rising) and `sunset` (h=0 falling),
- `dawn` (civil, h=-6° rising) and `dusk` (civil, h=-6° falling).

Returns the minimum valid candidate `> nowMs`. **Fallbacks (never NaN):**

- `lat`/`lon` null → `nextPhaseBoundaryMs(nowMs)` (synthetic).
- No valid candidate (polar) → `nowMs + QUADRANT_MS` (a bounded segment so the
  integrator still advances; the phase is constant across a polar day/night
  anyway, so the exact boundary is immaterial there).

## 4. Null-location semantics

`main.ts` blocks bootstrap on the location picker, so production always has
`world.playerLat/playerLon` set. The null path exists only for fixtures/tests
and any pre-picker frame. In all real-sun functions, `null` lat/lon **delegates
to the synthetic clock** (§3). This is why the synthetic helpers are retained:
they are the deterministic no-location fallback, not dead code.

## 5. Consumer migration (the 5 sites)

| # | Site | Function | Change |
|---|---|---|---|
| 1 | `hud.ts:384-387` | label | `realPhaseName` for the name; `nextSunEvent` for the countdown, displaying its `kind` + `atMs − now` (the kind is already correct per §3.2). Format: `Night · sunrise in 7h12m · solar 0.0×`. `nextSunEvent` null → omit the countdown segment entirely. Drop the `% through quadrant`. |
| 2 | `daynight-tint.ts:61` | `currentTint` | Pick the base tint by `realPhaseName`. Replace the synthetic-phase cross-fade with an **altitude-proximity** cross-fade near the `h=0` / `h=-6°` boundaries (blend window expressed in altitude, not phase units). lat/lon plumbed from the caller (`main.ts` tint mount). |
| 3 | `economy.ts:639` | `evaluateConditionalEffectCondition` (`during-night`) | `realPhaseName(nowMs, world.playerLat, world.playerLon) === 'night'`. `world` is already in scope. |
| 4 | `economy.ts:1786` | `advanceIsland` integrator | `nextPhaseMs = nextRealPhaseBoundaryMs(t + wallOffset, lat, lon) - wallOffset`. lat/lon reachable in `advanceIsland` (same source `computeRates`'s `solarMultiplier` call at line 784 already uses). Keeps the §15.3 piecewise-constant invariant: the now-real `during-night` boolean stays constant within each segment. `nextSolarBoundaryMs` (32 fixed segments) is **untouched**. |
| 5 | `weather.ts:179` | `weather` loop | Phase modulation uses `realPhaseName(t, lat, lon)`. **Signature change** — see §6. |

## 6. `weather()` signature change

`weather()` has **38 references across 9 files** (`economy.ts`, `routes.ts`,
`hover-tooltip.ts`, `weather-overlay.ts`, plus tests). To avoid touching all of
them:

- Add two **optional trailing** params:
  `weather(seed, cx, cy, nowMs, biome?, totalCo2Kg = 0, lat: number | null = null, lon: number | null = null)`.
- Inside the loop, `realPhaseName(t, lat, lon)` — with null/null this delegates
  to `dayPhaseName(t)`, so **every existing caller and test that omits lat/lon
  keeps its current deterministic behavior** (`weather.test.ts` stays green).
- Update only the callers that must reflect the real sun **and** that have the
  player location available, so simulation and display agree:
  - `economy.ts:634` (during-storm gate) — pass `world.playerLat/playerLon`.
  - `routes.ts:577` — pass player location (verify it has `world`).
  - `hover-tooltip.ts:287/293` and `weather-overlay.ts:144/159` (display) — pass
    player location so the shown weather matches the simulated weather.
- `findReferences` (LSP) re-run before editing to confirm the caller list and
  that no positional-arg caller breaks when two trailing optionals are added.

**Determinism note (accepted by user):** re-anchoring the modulation to the real
sun changes weather *history* for the real-location path. Existing seeds replay
differently. This is intended.

**Performance:** `weather()` loops up to `MAX_ITERATIONS = 1_000_000` calling the
phase function per iteration; real typical counts are far lower (it breaks when
the accumulated dwell passes `nowMs`). Each `realPhaseName` does ~2
`SunCalc.getPosition` calls. The implementer must **measure** a representative
`weather()` call's iteration count first; if it is large enough that 2× SunCalc
per iteration is material, memoize the phase per integration step (the loop
advances `t` in dwell-sized chunks, so phase changes slowly) rather than
recomputing each iteration. Decide based on the measurement, not assumption.

## 7. SPEC §2.7 update

§2.7 currently describes the synthetic 4-equal-quadrant model and states
"Time-of-day is global … there is no longitude variation." Update it to describe
the real-sun model: phase and solar output derive from the sun's true altitude
at the player's chosen coordinates; phases are not equal-length and vary by
season/latitude; the synthetic quadrant clock remains only as the no-location
fallback. Preserve the existing Mirror-Sat additive-boost and weather-modulation
prose (those mechanics are unchanged; only the phase *source* changes).

## 8. Testing

New `daynight.test.ts` cases (synthetic-clock cases stay as-is):

- `realPhaseName`:
  - Brno (49.20, 16.61) at a known UTC instant just after civil dusk in late
    May → `'night'` (the reported-bug regression: must NOT be `'dawn'`).
  - Equator equinox noon → `'day'`; local midnight → `'night'`.
  - Rising vs falling near the horizon → `'dawn'` vs `'dusk'` distinguished.
  - Null lat/lon → equals `dayPhaseName(now)` (fallback identity).
  - Polar (84°N, Dec 21) → never `'day'`, no throw/NaN.
- `nextSunEvent`:
  - Brno: returns a `sunrise` (when sun down) / `sunset` (when up) strictly after
    now; ordering correct across the day boundary.
  - Polar day/night → `null`.
  - Null lat/lon → `null`.
- `nextRealPhaseBoundaryMs`:
  - Strictly `> nowMs` for samples across a Brno day.
  - Null lat/lon → equals `nextPhaseBoundaryMs(now)`.
  - Polar → finite (`≤ now + QUADRANT_MS`), never NaN.
- `weather()` real-sun path: passing Brno lat/lon at a night instant boosts
  severe-storm weight vs. the same call with day-instant; omitting lat/lon
  reproduces the pre-change (synthetic) result.
- `daynight-tint` `currentTint`: returns the night tint for a Brno night instant.

Full `npm test` must pass; pre-existing `solarMultiplier` and synthetic-clock
suites must remain green (they are not modified).

## 9. Out of scope

- Deleting the synthetic helpers (`dayPhase`/`dayPhaseName`/`nextPhaseBoundaryMs`/
  `EPOCH_PHASE_OFFSET`) — explicitly retained as the fallback.
- Per-cell (per-longitude) sun variation — the player has a single global
  location; weather time-of-day uses that one location.
- Changing `solarMultiplier` or `nextSolarBoundaryMs` — already correct.
