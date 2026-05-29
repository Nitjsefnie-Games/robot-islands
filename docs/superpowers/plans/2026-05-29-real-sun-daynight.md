# Real-Sun Day-Night Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Commit trailer:** every commit in this plan must carry a `Co-Authored-By:` trailer for whoever authors it (the implementer's own model name), per repo policy.

**Goal:** Make the in-game day-night phase label, screen tint, the during-night economy gate, and the economy integrator's phase boundaries derive from the real sun at the player's chosen coordinates, instead of a synthetic UTC-quadrant clock.

**Architecture:** `solarMultiplier` already computes the true sun (SunCalc) — only solar *power* was real. We add three real-sun helpers to `daynight.ts` (`realPhaseName`, `nextSunEvent`, `nextRealPhaseBoundaryMs`) plus a `solarAltitude` helper and a `CIVIL_TWILIGHT_RAD` constant, then switch the four behavioral consumers to them. The synthetic helpers (`dayPhase`/`dayPhaseName`/`nextPhaseBoundaryMs`) are **kept**: they remain the null-location fallback and still drive `weather()` (excluded from this migration on measured-performance grounds). All four migrated consumers are O(1) per call, so no caching is needed.

**Tech Stack:** Vite 5 + TypeScript strict + PixiJS 8 + vitest. `suncalc` is already a dependency (`import SunCalc from 'suncalc'`). Reference spec: `docs/superpowers/specs/2026-05-29-real-sun-daynight-design.md`.

**Source-of-truth facts (verified against the live code & SunCalc during planning):**
- `world.playerLat` / `world.playerLon` is the canonical location accessor (already used at `hud.ts:386` and `economy.ts:786`).
- `DAY_DURATION_MS` and `QUADRANT_MS` are already exported from `daynight.ts`; `DayPhase` is the exported phase union; `dayPhaseName`, `dayPhase`, `nextPhaseBoundaryMs` remain exported.
- Verified phase/SunCalc values used in tests below: Brno (49.20, 16.61) at `2026-05-29T19:43:00Z` → altitude −7.73° → `night`; `02:40Z` → `dawn`; `19:00Z` → `dusk`; `10:00Z` sun up; equator `2026-03-20T12:00:00Z` → `day`; 84°N `2026-12-21T12:00:00Z` → `night` with all `getTimes` events `Invalid Date`; 84°N `2026-06-21T12:00:00Z` → `day`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/daynight.ts` | Pure day-night math | **Add** `CIVIL_TWILIGHT_RAD`, `solarAltitude`, `realPhaseName`, `SunEvent` + `nextSunEvent`, `nextRealPhaseBoundaryMs`. Keep all existing exports. |
| `src/daynight.test.ts` | Pure tests | **Add** describe blocks for the three new functions. |
| `src/hud.ts` | DOM economy panel | Phase label → real phase + countdown; swap imports; add `formatCountdown`. |
| `src/daynight-tint.ts` | Day/night tint overlay | `currentTint` + `refresh` gain optional `lat,lon`; real-sun altitude cross-fade; old body kept as `syntheticTint` fallback. |
| `src/main.ts` | Bootstrap/wiring | `dayNightTint.refresh(...)` passes `world.playerLat/playerLon`. |
| `src/economy.ts` | Tick loop | during-night gate + integrator boundary → real-sun; swap imports. |
| `src/economy.test.ts` | Economy tests | **Add** one real-sun during-night gate test. |
| `SPEC.md` | Locked spec | §2.7 prose updated to the real-sun model; weather noted as staying synthetic. |

`src/weather.ts` and its 38 call sites are **not touched** (weather stays synthetic — see spec §6).

---

### Task 1: `daynight.ts` — `CIVIL_TWILIGHT_RAD`, `solarAltitude`, `realPhaseName`

**Files:**
- Modify: `src/daynight.ts` (append after `solarMultiplier`, around line 95)
- Test: `src/daynight.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/daynight.test.ts`, extend the import from `./daynight.js` to include `realPhaseName` (add it to the existing import list at the top), then append this describe block at end of file:

```ts
describe('realPhaseName — real sun', () => {
  it("returns 'night' at 21:43 in Brno (reported-bug regression — not 'dawn')", () => {
    const t = new Date('2026-05-29T19:43:00Z').getTime(); // 21:43 CEST, sun at -7.7°
    expect(realPhaseName(t, 49.20, 16.61)).toBe('night');
  });

  it("returns 'day' at the equator on the equinox at noon", () => {
    const t = new Date('2026-03-20T12:00:00Z').getTime();
    expect(realPhaseName(t, 0, 0)).toBe('day');
  });

  it("returns 'dawn' while rising through morning twilight at Brno", () => {
    const t = new Date('2026-05-29T02:40:00Z').getTime(); // between civil dawn and sunrise
    expect(realPhaseName(t, 49.20, 16.61)).toBe('dawn');
  });

  it("returns 'dusk' while falling through evening twilight at Brno", () => {
    const t = new Date('2026-05-29T19:00:00Z').getTime(); // between sunset and civil dusk
    expect(realPhaseName(t, 49.20, 16.61)).toBe('dusk');
  });

  it('delegates to synthetic dayPhaseName when lat/lon is null', () => {
    for (const t of [0, 1234, DAY_DURATION_MS * 3.7]) {
      expect(realPhaseName(t, null, null)).toBe(dayPhaseName(t));
    }
  });

  it("never returns 'day' during polar night and does not throw", () => {
    const t = new Date('2026-12-21T12:00:00Z').getTime();
    expect(realPhaseName(t, 84, 0)).toBe('night');
  });

  it("returns 'day' under the midnight sun", () => {
    const t = new Date('2026-06-21T12:00:00Z').getTime();
    expect(realPhaseName(t, 84, 0)).toBe('day');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daynight.test.ts -t "realPhaseName"`
Expected: FAIL — `realPhaseName is not exported` / not a function.

- [ ] **Step 3: Implement the functions**

In `src/daynight.ts`, append after the `solarMultiplier` function (after line 95):

```ts
/** Civil twilight threshold (sun 6° below the geometric horizon), in radians.
 *  Bounds the Dawn/Dusk bands; below it is Night. */
export const CIVIL_TWILIGHT_RAD = (-6 * Math.PI) / 180;

/** Sun altitude in radians at the player's location, or null when lat/lon is
 *  unset. Centralises the SunCalc call for the real-sun phase + tint helpers. */
export function solarAltitude(
  nowMs: number,
  lat: number | null,
  lon: number | null,
): number | null {
  if (lat == null || lon == null) return null;
  return SunCalc.getPosition(new Date(nowMs), lat, lon).altitude;
}

/**
 * Real-astronomy day-phase name at the player's location. Altitude-based and
 * NaN-free (SunCalc.getPosition always returns a finite altitude), so polar
 * night never yields 'day' and midnight sun is always 'day'.
 *
 * Null lat/lon delegates to the synthetic `dayPhaseName` (the no-location
 * fallback — fixtures / tests / pre-picker frames).
 */
export function realPhaseName(
  nowMs: number,
  lat: number | null,
  lon: number | null,
): DayPhase {
  const h = solarAltitude(nowMs, lat, lon);
  if (h == null) return dayPhaseName(nowMs);
  if (h >= 0) return 'day';
  if (h < CIVIL_TWILIGHT_RAD) return 'night';
  // Twilight band: rising → dawn, falling → dusk. lat/lon are non-null here, so
  // the 60s-ahead sample is non-null too.
  const hNext = solarAltitude(nowMs + 60_000, lat, lon)!;
  return hNext > h ? 'dawn' : 'dusk';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daynight.test.ts -t "realPhaseName"`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daynight.ts src/daynight.test.ts
git commit -m "feat(daynight): realPhaseName + solarAltitude (real-sun phase)"
```

---

### Task 2: `daynight.ts` — `SunEvent` + `nextSunEvent`

**Files:**
- Modify: `src/daynight.ts`
- Test: `src/daynight.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `nextSunEvent` to the `./daynight.js` import in `src/daynight.test.ts`, then append:

```ts
describe('nextSunEvent', () => {
  it('returns the next sunrise (with kind) when the sun is down at Brno', () => {
    const t = new Date('2026-05-29T19:43:00Z').getTime();
    const ev = nextSunEvent(t, 49.20, 16.61);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('sunrise');
    expect(ev!.atMs).toBeGreaterThan(t);
    expect((ev!.atMs - t) / 3_600_000).toBeCloseTo(7.2, 0); // ~7.2h to sunrise
  });

  it('returns the next sunset when the sun is up at Brno mid-morning', () => {
    const t = new Date('2026-05-29T10:00:00Z').getTime();
    const ev = nextSunEvent(t, 49.20, 16.61);
    expect(ev).not.toBeNull();
    expect(ev!.kind).toBe('sunset');
  });

  it('returns null at high latitude with no sunrise/sunset (polar)', () => {
    const t = new Date('2026-12-21T12:00:00Z').getTime();
    expect(nextSunEvent(t, 84, 0)).toBeNull();
  });

  it('returns null when lat/lon is null', () => {
    expect(nextSunEvent(0, null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daynight.test.ts -t "nextSunEvent"`
Expected: FAIL — `nextSunEvent is not exported`.

- [ ] **Step 3: Implement the function**

In `src/daynight.ts`, append after `realPhaseName`:

```ts
export interface SunEvent {
  readonly kind: 'sunrise' | 'sunset';
  readonly atMs: number;
}

/**
 * Earliest sunrise/sunset strictly after `nowMs` at the player's location, with
 * its kind. Scans the location-days bracketing `nowMs` (today + tomorrow) so an
 * event later today or early tomorrow is always found; the earliest future
 * crossing's kind is automatically the meaningful one (sun up → next is sunset;
 * down → sunrise). Returns null when lat/lon is null, or where SunCalc yields no
 * sunrise/sunset (Invalid Date → NaN, guarded) — e.g. polar day/night.
 */
export function nextSunEvent(
  nowMs: number,
  lat: number | null,
  lon: number | null,
): SunEvent | null {
  if (lat == null || lon == null) return null;
  let best: SunEvent | null = null;
  for (const dayOffset of [0, 1]) {
    const times = SunCalc.getTimes(new Date(nowMs + dayOffset * DAY_DURATION_MS), lat, lon);
    const events: ReadonlyArray<{ kind: 'sunrise' | 'sunset'; date: Date }> = [
      { kind: 'sunrise', date: times.sunrise },
      { kind: 'sunset', date: times.sunset },
    ];
    for (const e of events) {
      const ms = e.date.getTime();
      if (!Number.isNaN(ms) && ms > nowMs && (best === null || ms < best.atMs)) {
        best = { kind: e.kind, atMs: ms };
      }
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daynight.test.ts -t "nextSunEvent"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/daynight.ts src/daynight.test.ts
git commit -m "feat(daynight): nextSunEvent for the HUD countdown"
```

---

### Task 3: `daynight.ts` — `nextRealPhaseBoundaryMs`

**Files:**
- Modify: `src/daynight.ts`
- Test: `src/daynight.test.ts`

- [ ] **Step 1: Write the failing tests**

Add `nextRealPhaseBoundaryMs` to the `./daynight.js` import in `src/daynight.test.ts` (`nextPhaseBoundaryMs` and `QUADRANT_MS` are already imported there), then append:

```ts
describe('nextRealPhaseBoundaryMs', () => {
  it('is strictly greater than nowMs across a Brno day', () => {
    const base = new Date('2026-05-29T00:00:00Z').getTime();
    for (let h = 0; h < 24; h++) {
      const t = base + h * 3_600_000;
      expect(nextRealPhaseBoundaryMs(t, 49.20, 16.61)).toBeGreaterThan(t);
    }
  });

  it('delegates to synthetic nextPhaseBoundaryMs when lat/lon is null', () => {
    for (const t of [0, 1234, DAY_DURATION_MS * 3.7]) {
      expect(nextRealPhaseBoundaryMs(t, null, null)).toBe(nextPhaseBoundaryMs(t));
    }
  });

  it('returns a finite, bounded fallback at the pole (≤ now + QUADRANT_MS)', () => {
    const t = new Date('2026-12-21T12:00:00Z').getTime();
    const b = nextRealPhaseBoundaryMs(t, 84, 0);
    expect(Number.isFinite(b)).toBe(true);
    expect(b).toBeGreaterThan(t);
    expect(b).toBeLessThanOrEqual(t + QUADRANT_MS);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/daynight.test.ts -t "nextRealPhaseBoundaryMs"`
Expected: FAIL — `nextRealPhaseBoundaryMs is not exported`.

- [ ] **Step 3: Implement the function**

In `src/daynight.ts`, append after `nextSunEvent`:

```ts
/**
 * Wall-clock time of the next real day-phase transition strictly after `nowMs`
 * at the player's location: the earliest of civil dawn (h=-6° rising), sunrise
 * (h=0 rising), sunset (h=0 falling), civil dusk (h=-6° falling), over the
 * location-days bracketing `nowMs`. The economy integrator clamps each segment
 * to this so the now-real during-night boolean stays constant within a segment
 * (§15.3 piecewise-constant-rate invariant).
 *
 * Fallbacks (never NaN): null lat/lon → synthetic `nextPhaseBoundaryMs`; no
 * valid candidate (polar day/night — all events Invalid Date) → nowMs +
 * QUADRANT_MS (phase is constant across a polar day anyway, so the exact bound
 * is immaterial; this keeps the integrator advancing in bounded steps).
 */
export function nextRealPhaseBoundaryMs(
  nowMs: number,
  lat: number | null,
  lon: number | null,
): number {
  if (lat == null || lon == null) return nextPhaseBoundaryMs(nowMs);
  let best = Infinity;
  for (const dayOffset of [0, 1]) {
    const times = SunCalc.getTimes(new Date(nowMs + dayOffset * DAY_DURATION_MS), lat, lon);
    for (const ev of [times.dawn, times.sunrise, times.sunset, times.dusk]) {
      const ms = ev.getTime();
      if (!Number.isNaN(ms) && ms > nowMs && ms < best) best = ms;
    }
  }
  return Number.isFinite(best) ? best : nowMs + QUADRANT_MS;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/daynight.test.ts -t "nextRealPhaseBoundaryMs"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole daynight suite (synthetic tests must still pass)**

Run: `npx vitest run src/daynight.test.ts`
Expected: PASS — all new + pre-existing (`dayPhase`, `solarMultiplier`, `nextPhaseBoundaryMs`, `nextSolarBoundaryMs`) cases green.

- [ ] **Step 6: Commit**

```bash
git add src/daynight.ts src/daynight.test.ts
git commit -m "feat(daynight): nextRealPhaseBoundaryMs for the §15.3 integrator"
```

---

### Task 4: `hud.ts` — phase label → real phase + countdown

**Files:**
- Modify: `src/hud.ts` (import line 11; add `formatCountdown`; label block 382–387)

This is render-layer (DOM); it is verified by the build (Task 8) and the browser smoke. `hud.test.ts` has no phase-label assertions, so it is unaffected.

- [ ] **Step 1: Swap the daynight import**

In `src/hud.ts`, replace line 11:

```ts
import { dayPhase, dayPhaseName, solarMultiplier, type DayPhase } from './daynight.js';
```

with:

```ts
import { nextSunEvent, realPhaseName, solarMultiplier, type DayPhase } from './daynight.js';
```

- [ ] **Step 2: Add the countdown formatter**

In `src/hud.ts`, immediately after the `PHASE_LABEL` constant (it ends at line 70), add:

```ts
/** Compact "7h12m" / "12m" / "<1m" countdown for the day-phase readout. */
function formatCountdown(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 1) return '<1m';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
```

- [ ] **Step 3: Rewrite the phase label block**

In `src/hud.ts`, replace the block at lines 382–387:

```ts
    // Phase
    const nowMs = Date.now();
    const phaseName = dayPhaseName(nowMs);
    const phaseFrac = (dayPhase(nowMs) * 4) % 1;
    const mul = solarMultiplier(nowMs, world.playerLat, world.playerLon);
    phaseEl.textContent = `${PHASE_LABEL[phaseName]} ${Math.floor(phaseFrac * 100)}% · solar ${mul.toFixed(1)}×`;
```

with:

```ts
    // Phase — real sun at the player's location (§2.7).
    const nowMs = Date.now();
    const phaseName = realPhaseName(nowMs, world.playerLat, world.playerLon);
    const mul = solarMultiplier(nowMs, world.playerLat, world.playerLon);
    const ev = nextSunEvent(nowMs, world.playerLat, world.playerLon);
    const countdown = ev ? ` · ${ev.kind} in ${formatCountdown(ev.atMs - nowMs)}` : '';
    phaseEl.textContent = `${PHASE_LABEL[phaseName]}${countdown} · solar ${mul.toFixed(1)}×`;
```

- [ ] **Step 4: Type-check the file**

Run: `npx tsc -b`
Expected: PASS — no unused-import error (`dayPhase`/`dayPhaseName` removed), no type errors.

- [ ] **Step 5: Run the hud suite (regression guard)**

Run: `npx vitest run src/hud.test.ts`
Expected: PASS (unchanged — no phase-label assertions there).

- [ ] **Step 6: Commit**

```bash
git add src/hud.ts
git commit -m "feat(hud): day-phase label tracks real sun + sunrise/sunset countdown"
```

---

### Task 5: `daynight-tint.ts` — real-sun tint + `main.ts` wiring

**Files:**
- Modify: `src/daynight-tint.ts` (import line 15; `currentTint`; `DayNightTintHandle.refresh`; `mountDayNightTint` refresh impl)
- Modify: `src/main.ts:2079`

Existing `daynight-tint.test.ts` calls `currentTint(MID_DAY)` with **one argument**; the new optional `lat,lon` default to null and route to the retained synthetic path, so those tests stay green.

- [ ] **Step 1: Swap the daynight import**

In `src/daynight-tint.ts`, replace line 15:

```ts
import { DAY_DURATION_MS, dayPhase } from './daynight.js';
```

with:

```ts
import { CIVIL_TWILIGHT_RAD, DAY_DURATION_MS, dayPhase, solarAltitude } from './daynight.js';
```

- [ ] **Step 2: Add the altitude-fade constant and rewrite `currentTint`**

In `src/daynight-tint.ts`, replace the entire `currentTint` function (lines 58–84) with the real-sun version plus a renamed synthetic fallback:

```ts
/** ±2° altitude cross-fade half-window around the h=0 and h=-6° boundaries. */
const TINT_FADE_RAD = (2 * Math.PI) / 180;

/** Pure helper: the tint to apply at `nowMs`. With lat/lon it follows the real
 *  sun (altitude-driven cross-fades at the h=0 and h=-6° boundaries); with null
 *  lat/lon it falls back to the synthetic-quadrant tint. Exported for unit
 *  testing — the DOM-write side is mountDayNightTint below. */
export function currentTint(
  nowMs: number,
  lat: number | null = null,
  lon: number | null = null,
): PhaseTint {
  const h = solarAltitude(nowMs, lat, lon);
  if (h == null) return syntheticTint(nowMs);
  // Twilight tint: rising → dawn, falling → dusk (lat/lon non-null here).
  const hNext = solarAltitude(nowMs + 60_000, lat, lon)!;
  const twilight = hNext > h ? PHASE_TINT.dawn : PHASE_TINT.dusk;
  // Cross-fade near h = 0 (twilight ↔ day).
  if (Math.abs(h) <= TINT_FADE_RAD) {
    const t = Math.min(1, Math.max(0, (h + TINT_FADE_RAD) / (2 * TINT_FADE_RAD)));
    return blendTints(twilight, PHASE_TINT.day, t);
  }
  // Cross-fade near h = -6° (night ↔ twilight).
  if (Math.abs(h - CIVIL_TWILIGHT_RAD) <= TINT_FADE_RAD) {
    const t = Math.min(1, Math.max(0, (h - (CIVIL_TWILIGHT_RAD - TINT_FADE_RAD)) / (2 * TINT_FADE_RAD)));
    return blendTints(PHASE_TINT.night, twilight, t);
  }
  if (h >= 0) return PHASE_TINT.day;
  if (h < CIVIL_TWILIGHT_RAD) return PHASE_TINT.night;
  return twilight;
}

/** Synthetic-quadrant tint — the pre-real-sun behaviour, retained as the
 *  null-location fallback. */
function syntheticTint(nowMs: number): PhaseTint {
  const p = dayPhase(nowMs);
  const phaseWidth = TRANSITION_MS / DAY_DURATION_MS;
  // Find which boundary we're near.
  for (const b of PHASE_BOUNDARIES) {
    const dist = Math.abs(p - b.phase);
    const wrapDist = Math.min(dist, 1 - dist);
    if (wrapDist <= phaseWidth / 2) {
      // Within the cross-fade window. Compute t in [0, 1] across the window.
      const start = b.phase - phaseWidth / 2;
      let pp = p - start;
      if (pp < 0) pp += 1;
      const t = Math.min(1, Math.max(0, pp / phaseWidth));
      return blendTints(PHASE_TINT[b.from], PHASE_TINT[b.to], t);
    }
  }
  // Not in any transition — pick the quadrant's tint.
  if (p < 0.25) return PHASE_TINT.dawn;
  if (p < 0.5) return PHASE_TINT.day;
  if (p < 0.75) return PHASE_TINT.dusk;
  return PHASE_TINT.night;
}
```

- [ ] **Step 3: Thread lat/lon through the handle's `refresh`**

In `src/daynight-tint.ts`, update the `DayNightTintHandle` interface (line 86–90) `refresh` signature:

```ts
export interface DayNightTintHandle {
  refresh(nowMs: number, lat?: number | null, lon?: number | null): void;
  /** Test/debug seam — exposes the tint DOM element for assertions. */
  readonly el: HTMLDivElement;
}
```

and the `refresh` implementation inside `mountDayNightTint` (lines 109–116):

```ts
    refresh(nowMs: number, lat: number | null = null, lon: number | null = null): void {
      const tint = currentTint(nowMs, lat, lon);
      if (last && Math.abs(last.alpha - tint.alpha) < 0.005 && last.color === tint.color) {
        return;
      }
      el.style.backgroundColor = tint.color;
      el.style.opacity = String(tint.alpha);
      last = tint;
    },
```

- [ ] **Step 4: Pass the player location from `main.ts`**

In `src/main.ts`, replace line 2079:

```ts
    dayNightTint.refresh(nowWall);
```

with:

```ts
    dayNightTint.refresh(nowWall, world.playerLat, world.playerLon);
```

- [ ] **Step 5: Add a real-sun tint test**

In `src/daynight-tint.test.ts`, append inside the `describe('currentTint', ...)` block:

```ts
  it('returns the night tint for a Brno night instant (real sun)', () => {
    const t = new Date('2026-05-29T19:43:00Z').getTime();
    const tint = currentTint(t, 49.20, 16.61);
    expect(tint.alpha).toBeGreaterThan(0.2); // night alpha is 0.32
  });

  it('still returns the synthetic result for a one-arg call (fallback guard)', () => {
    expect(currentTint(MID_DAY).alpha).toBe(0); // synthetic Day midpoint
  });
```

- [ ] **Step 6: Type-check and run the tint suite**

Run: `npx tsc -b && npx vitest run src/daynight-tint.test.ts`
Expected: PASS — existing one-arg cases unchanged; two new cases green.

- [ ] **Step 7: Commit**

```bash
git add src/daynight-tint.ts src/daynight-tint.test.ts src/main.ts
git commit -m "feat(daynight-tint): tint follows real sun; synthetic kept as fallback"
```

---

### Task 6: `economy.ts` — during-night gate → real sun

**Files:**
- Modify: `src/economy.ts` (import line 40; during-night case 637–640)
- Test: `src/economy.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/economy.test.ts`, ensure `WorldState` is imported from `./world.js` (add it to the existing `./world.js` import if absent). Then add this test next to the other `during-night` tests (after line 3855):

```ts
  it('evaluateConditionalEffectCondition — during-night uses the real sun when a location is set', () => {
    const state = makeState();
    // Brno; minimal world carrying only the player location the gate reads.
    const world = { playerLat: 49.20, playerLon: 16.61 } as unknown as WorldState;
    const nightMs = new Date('2026-05-29T19:43:00Z').getTime(); // sun at -7.7° → night
    const dayMs = new Date('2026-05-29T10:00:00Z').getTime();   // sun up → day
    expect(evaluateConditionalEffectCondition({ kind: 'during-night' }, state, world, nightMs)).toBe(true);
    expect(evaluateConditionalEffectCondition({ kind: 'during-night' }, state, world, dayMs)).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/economy.test.ts -t "during-night uses the real sun"`
Expected: FAIL — current synthetic `dayPhaseName(nightMs)` ignores location, so the night assertion fails.

- [ ] **Step 3: Swap the daynight import**

In `src/economy.ts`, replace line 40:

```ts
import { dayPhaseName, nextPhaseBoundaryMs, nextSolarBoundaryMs, solarMultiplier } from './daynight.js';
```

with:

```ts
import { nextRealPhaseBoundaryMs, nextSolarBoundaryMs, realPhaseName, solarMultiplier } from './daynight.js';
```

(`dayPhaseName` and `nextPhaseBoundaryMs` had no other consumers in `economy.ts`; `nextRealPhaseBoundaryMs` is used in Task 7.)

- [ ] **Step 4: Switch the during-night gate**

In `src/economy.ts`, replace the `during-night` case (lines 637–640):

```ts
    case 'during-night': {
      if (nowMs === undefined) return false;
      return dayPhaseName(nowMs) === 'night';
    }
```

with:

```ts
    case 'during-night': {
      if (nowMs === undefined) return false;
      return realPhaseName(nowMs, world?.playerLat ?? null, world?.playerLon ?? null) === 'night';
    }
```

- [ ] **Step 5: Run the new test and the existing during-night tests**

Run: `npx vitest run src/economy.test.ts -t "during-night"`
Expected: PASS — the new real-sun test passes; the three pre-existing `world=undefined` tests still pass (null lat/lon → synthetic `dayPhaseName`, unchanged).

> Note: Task 7 also edits `src/economy.ts` and uses the `nextRealPhaseBoundaryMs` import added here. `npx tsc -b` will report `nextRealPhaseBoundaryMs` as unused until Task 7 lands — defer the full type-check to the end of Task 7. (If implementing as one combined commit, do Steps 1–4 here then Task 7's Steps before committing.)

- [ ] **Step 6: Commit**

```bash
git add src/economy.ts src/economy.test.ts
git commit -m "feat(economy): during-night gate tracks the real sun at player location"
```

---

### Task 7: `economy.ts` — integrator phase boundary → real sun

**Files:**
- Modify: `src/economy.ts` (integrator boundary, line 1786, inside `advanceIsland`)

The substituted function (`nextRealPhaseBoundaryMs`) is unit-tested in Task 3; this is the one-line wiring. For existing economy tests `ctx.world` is absent/has no `playerLat`, so lat/lon resolve to null → synthetic `nextPhaseBoundaryMs` → byte-identical integrator behaviour. The real boundary path is exercised only when a location is set.

- [ ] **Step 1: Replace the boundary computation**

In `src/economy.ts`, replace line 1786:

```ts
    const nextPhaseMs = nextPhaseBoundaryMs(t + wallOffset) - wallOffset;
```

with:

```ts
    const phaseLat = ctx?.world?.playerLat ?? null;
    const phaseLon = ctx?.world?.playerLon ?? null;
    const nextPhaseMs = nextRealPhaseBoundaryMs(t + wallOffset, phaseLat, phaseLon) - wallOffset;
```

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc -b`
Expected: PASS — `nextRealPhaseBoundaryMs` now used; no unused imports; strict-clean.

- [ ] **Step 3: Run the full economy suite (regression guard)**

Run: `npx vitest run src/economy.test.ts`
Expected: PASS — all pre-existing economy tests green (null-location fallback keeps integrator behaviour identical), plus the Task 6 real-sun gate test.

- [ ] **Step 4: Commit**

```bash
git add src/economy.ts
git commit -m "feat(economy): integrator phase boundaries follow the real sun"
```

---

### Task 8: SPEC §2.7 update + full verification

**Files:**
- Modify: `SPEC.md` (§2.7, lines ~271–283)

- [ ] **Step 1: Update SPEC §2.7 prose**

In `SPEC.md`, replace this block (the opening paragraph through the solar-output bullets):

```
The world has a 24-real-hour day-night cycle. Time-of-day is global — the same phase applies everywhere; there is no longitude variation. Time-of-day is computed as `phase = (world\_tick % seconds\_per\_real\_day) / seconds\_per\_real\_day`, normalized to [0, 1):

* 0.00–0.25: Dawn
* 0.25–0.50: Day
* 0.50–0.75: Dusk
* 0.75–1.00: Night

**Solar buildings (Solar Panel, Sunspire, Solar cell production):**

* Day: 100% output
* Dusk: 50% output (linear ramp from 100 → 0)
* Night: 0% output
* Dawn: 50% output (linear ramp from 0 → 100)
```

with:

```
The world's day-night cycle tracks the **real sun at the player's chosen geographic coordinates** (`world.playerLat` / `world.playerLon`), computed via SunCalc. The phase label, the full-viewport tint, the during-night gameplay gate, and the economy integrator's segment boundaries all derive from the sun's true altitude `h` there. Phases are **not** equal-length and vary by season and latitude:

* `h ≥ 0°` — Day
* `−6° ≤ h < 0°`, rising — Dawn
* `−6° ≤ h < 0°`, falling — Dusk
* `h < −6°` (civil twilight) — Night

**Solar buildings (Solar Panel, Sunspire, Solar cell production):** output is `sin(h)` clamped to `[0, 1]` (0 below the horizon), i.e. real insolation — full at the sun's zenith, ramping smoothly through dawn and dusk, zero at night. This is the long-standing `solarMultiplier(t, lat, lon)` behaviour.

When no location is set (fixtures / tests / pre-picker frames) the system falls back to a synthetic 24-hour quadrant clock (`dayPhase`/`dayPhaseName`, four equal 6-hour quadrants offset so `t = 0` lands in Day). **Weather phase-modulation (below) deliberately stays on this synthetic clock** — its severe-storm boost runs in a per-cell historical replay loop where real astronomy is prohibitively expensive, and the boost is imperceptible as real time-of-day. Polar latitudes: the altitude-based phase has no singularity (polar night is never Day; midnight sun is always Day); sunrise/sunset-dependent readouts (the HUD countdown) are simply omitted where no such event exists.
```

- [ ] **Step 2: Verify the weather-modulation note is consistent**

Confirm the existing "**Weather modulation by phase:**" paragraph in §2.7 (severe-storm +25% during Night/Dawn) still reads correctly — it is unchanged in behaviour and now explicitly synthetic per the paragraph added above. No edit needed unless it claims real-sun coupling (it does not).

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: PASS — entire vitest suite green, including the new daynight / economy / tint cases and all pre-existing suites (`weather.test.ts` untouched).

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: PASS — `tsc -b` strict-clean (no unused locals/params, no type errors) and `vite build` succeeds.

- [ ] **Step 5: Browser smoke test**

Per `AGENTS.md`: the dev service serves built `dist/` with no HMR, so a build + reload is required before screenshotting.

1. `npm run build` (done in Step 4).
2. Reload the open tab on `https://islands.nitjsefni.eu/` (Daedalus: `mcp__daedalus__reload`, then `mcp__daedalus__screenshot`).
3. Confirm the HUD phase chip reads a sane real-sun value for the current Brno time — e.g. at 21:43 local it shows `Night · sunrise in …h…m · solar 0.0×`, **not** `Dawn 78%`. Confirm the screen tint matches (dark-blue night tint, not the warm dawn tint).

- [ ] **Step 6: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): §2.7 day-night cycle now tracks the real sun (weather stays synthetic)"
```

---

## Done criteria

- `realPhaseName`, `nextSunEvent`, `nextRealPhaseBoundaryMs`, `solarAltitude`, `CIVIL_TWILIGHT_RAD` exist in `daynight.ts` with passing unit tests.
- HUD label, screen tint, during-night gate, and integrator boundary all consume the real-sun functions with the player's coordinates; null location falls back to the synthetic clock.
- `weather.ts` and its call sites are unchanged; `dayPhaseName`/`dayPhase`/`nextPhaseBoundaryMs` remain exported and used (weather + fallback).
- `npm test` and `npm run build` both pass; browser smoke shows the correct real-sun phase + countdown at Brno's current time.
- SPEC §2.7 describes the real-sun model and the synthetic-clock fallback / weather exception.
