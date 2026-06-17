# Plan: Decouple path-drawn drone flight from T5 + explicit Path/Simple toggle (#116)

## Mental model (locked)
Two orthogonal axes:
- **Tier** (1 … island tier, ≤ T5): economics ONLY — fuel grade, efficiency/range, scan radius, weather-destruction multiplier.
- **Mode toggle** (Path ⇄ Simple): geometry + direction + speed.
  - **Path** = one-way drawn polyline (ends `stranded`, telemetry recovered only in antenna range — per #117), flies at path speed.
  - **Simple** = round-trip straight line (out to a clicked target and back, returns home), flies at simple speed.

Today these are coupled: drawing a path forces a T5 drone with a special path-only efficiency. #116 splits them so e.g. a **T2 Path** drone (one-way drawn route, T2 economics) and a **T5 Simple** drone (round-trip straight line, T5 economics) are both possible.

## Efficiency model (the key decision)
`DRONE_TIER_EFFICIENCY[tier]` = tiles flown per fuel unit (total flight). This is mode-independent — the drone burns the same fuel per tile it flies regardless of geometry:
- **Simple** (round-trip): max outbound = `fuel × eff / 2` (the other half is the return).
- **Path** (one-way): max drawn length = `fuel × eff` (all of it is forward).

So path efficiency = the tier's own efficiency. The old special `DRONE_T5_EFFICIENCY = 8` (a path-only one-way budget) is **removed**. Consequence: T5 path one-way reach goes `fuel×8 → fuel×15` — a deliberate balance change, and lower tiers gain path access at their own economics. Document in SPEC.

**Speed stays mode-based** (it already is — all straight-line tiers share one speed): Path → `DRONE_T5_SPEED_TILES_PER_SEC` (0.8), Simple → `DRONE_SPEED_TILES_PER_SEC` (0.5). Keep the `DRONE_T5_SPEED_TILES_PER_SEC` name; add a comment that it is the **path-mode** speed, tier-independent.

## Surface
- `src/drones.ts` (pure) — tier resolution + efficiency; remove `DRONE_T5_EFFICIENCY`.
- `src/drones-ui-helpers.ts` — helpers take the tier's efficiency instead of hardcoding T5.
- `src/drones-ui.ts` (render) — replace the `'5-path'` magic tier with a numeric tier picker + a separate Path toggle; send the tier with waypoints.
- `src/drones.test.ts`, `src/drones-ui-helpers.test.ts` — update/extend.
- `src/drones-ui.ts` (render) — replace `'5-path'`, add toggle, send tier, **and simplify `canUsePathMode()` to island-T5 only**.
- `server/src/game/intents.ts` — **drop the path-mode foundry gate** (Phase 4).
- `SPEC.md` §11.5/§11.6/§11.7.
- **No change** to mutation-gateway or persistence (verify in review).
- Note: with aiCore + foundry no longer gating path mode, the `path_drone_foundry` building (and the `aiCoreCrafted` flag's role here) become vestigial *for this purpose* — do NOT delete the building/flag (out of scope, other systems may reference them); just stop gating on them. Flag as a CONCERN if either is now wholly unused.

## Phase 1 — pure layer (`src/drones.ts`)
1. In `dispatchDrone`, **remove** `if (isPathDrawn) resolvedTier = 5;`. Tier resolution becomes identical for both modes: honor `selectedTier` when `1 ≤ selectedTier ≤ islandTier`, else default `islandTier`.
2. `efficiency = DRONE_TIER_EFFICIENCY[resolvedTier] * fuelEffMul` — remove the `isPathDrawn ? DRONE_T5_EFFICIENCY : …` branch.
3. Keep `speed = isPathDrawn ? DRONE_T5_SPEED_TILES_PER_SEC : DRONE_SPEED_TILES_PER_SEC`. Update the `DRONE_T5_SPEED_TILES_PER_SEC` comment to "path-mode speed (tier-independent)".
4. Delete the `export const DRONE_T5_EFFICIENCY = 8;` constant. (`scanRadius`, weather multiplier already key off `resolvedTier`/`tier`, so they become tier-correct automatically once the forced-5 is gone.)
5. The #117 one-way path math and #122 are unchanged in shape — only `efficiency` now comes from the tier.

TDD tests (drones.test.ts):
- Path-drawn with `selectedTier = 2` on a T5 island → `drone.tier === 2`, fuel grade = `fuelForTier(2)`, one-way range uses `DRONE_TIER_EFFICIENCY[2]` (reject when `len > fuel×6×mul`), `scanRadius === DRONE_TIER_SCAN_RADIUS[2]`, weather mult = `DRONE_TIER_MULTIPLIERS[2]`, path speed.
- Path-drawn with `selectedTier` omitted → defaults to island tier (regression of prior "no tier" path dispatch, but now island tier not hardcoded 5).
- Simple (no waypoints) `selectedTier = 5` → unchanged round-trip.
- Update any test importing `DRONE_T5_EFFICIENCY` to use `DRONE_TIER_EFFICIENCY[5]` and the new one-way semantics (path-T5 reach is now `fuel×15` one-way, not `fuel×8`).

## Phase 2 — helpers (`src/drones-ui-helpers.ts`)
`wouldExceedRange` and `fuelForPath` currently hardcode `DRONE_T5_EFFICIENCY`. Replace with a passed **`tierEfficiency`** parameter (the per-fuel one-way tile budget = `DRONE_TIER_EFFICIENCY[selectedTier]`), keeping `efficiencyMul`:
- `wouldExceedRange(origin, waypoints, next, tierEfficiency, efficiencyMul = 1)`: `maxOneWay = MAX_FUEL_PER_DRONE * tierEfficiency * efficiencyMul` (one-way, no /2 — from #122).
- `fuelForPath(origin, waypoints, tierEfficiency, efficiencyMul = 1)`: `ceil(length / (tierEfficiency * efficiencyMul))`.
- Drop the `DRONE_T5_EFFICIENCY` import. Update doc comments. Update callers + tests (tests now pass an explicit `tierEfficiency`, e.g. `DRONE_TIER_EFFICIENCY[5] = 15` → one-way cap `50×15 = 750`).

## Phase 3 — UI (`src/drones-ui.ts`)
1. **State:** change `selectedTier: DroneTier | '5-path'` → `selectedTier: DroneTier` (numeric) **plus** a new `let pathMode = false;`.
2. **Tier selector:** remove the `'5-path'` option (`pathOpt`); keep numeric T1–T6 with `refresh()` disabling tiers above island tier. The change handler sets `selectedTier = Number(v)` only.
3. **Path toggle:** add a checkbox-style control (label `PATH`) near the tier row. Enabled iff `canUsePathMode()`; when disabled, force `pathMode = false` and uncheck. Its change handler sets `pathMode`, clears `waypointBuffer`, `refresh()`, repaint ring.
   - **`canUsePathMode()` is SIMPLIFIED to island-T5 only:** keep `tierForLevel(origin.level) >= 5`; **DROP** the `origin.aiCoreCrafted` check (line 330) and the `hasOperationalBuilding(origin.buildings, 'path_drone_foundry')` check (line 331). Path mode is now available on any T5 island regardless of AI core or foundry. (The Drone Pad gate on launches in general is unchanged.)
4. Replace **every** `selectedTier === '5-path'` with `pathMode` (≈ refs at the dashed-preview branch, finalizePath/popWaypoint/cancel guards, refresh fuel/eff resolution, the #122 mode-conditional ring/reticle/ETA/stat branches).
5. **Efficiency/fuel resolution** (refresh, ~1072–1083): `fuelResource = fuelForTier(selectedTier)` always (drop the `plasma_charge` special); `eff = DRONE_TIER_EFFICIENCY[selectedTier]`; `currentEfficiency = eff * currentFuelEffMul` for both modes. Helper calls pass `DRONE_TIER_EFFICIENCY[selectedTier]` as `tierEfficiency`.
6. **finalizePath:** send the tier WITH the waypoints — `deps.gateway.dispatchDrone(id, ox, oy, 1, 0, fuel, nowMs, waypointsForDispatch, selectedTier, …)` (and the LOCAL `dispatchDrone(...)` call likewise passes `selectedTier`). Previously it omitted the tier to force T5; now the server/pure layer must use the chosen tier.
7. The #122 path-vs-simple display branches (ring radius, reticle outbound + ETA, OUTBND/FLIGHT stats) stay, keyed on `pathMode`, using `DRONE_TIER_EFFICIENCY[selectedTier]` and path speed for the path branch.

## Phase 4 — server (CHANGE: drop the foundry gate, for parity with the UI)
`server/src/game/intents.ts` `dispatch-drone`:
- **DROP** the path-mode foundry gate (lines 457-459: `if (isPathDrawn && !hasOperationalBuilding(... 'path_drone_foundry')) return 'no-operational-path-drone-foundry'`). Path no longer requires the foundry. Keep the general `dronepad` gate (line ~454) — that still gates all launches.
- It already validates `selectedTier` (1..6) and `waypoints` independently. With the forced-5 removed in `dispatchDrone`, sending `selectedTier=N` + waypoints flies a tier-N path drone. There is **no server-side AI-core or island-tier gate** to remove (none exists). The UI's island-T5 gate is a UX affordance; the server simply trusts the validated tier+waypoints.
- Parity: after this change, any LOCAL path dispatch the UI permits is also accepted REMOTE (no foundry/aiCore rejection). Verify in review (LOCAL and REMOTE).

## Phase 5 — SPEC.md
§11.5/§11.6: path mode is decoupled from tier — any tier up to the island tier can fly Path (one-way) or Simple (round-trip); tier sets economics, the mode sets geometry/direction/speed. **Path-mode access gate is now island tier ≥ 5 ONLY** — update any spec text that lists "AI core crafted" and "Path Drone Foundry built" as path-mode requirements (those gates are removed). Note the balance change: path range now uses the tier's own efficiency (T5 path one-way `fuel×15`, was `fuel×8`); `DRONE_T5_EFFICIENCY` removed. §11.7 range note: one-way path reach = `fuel×eff`, simple outbound = `fuel×eff/2`, both using the tier's efficiency.

## Verification gate (reviewer runs it)
- `npx vitest run src/drones.test.ts src/drones-ui-helpers.test.ts` green
- `npx tsc -b` clean; `cd server && npx tsc --noEmit` clean
- full `npm test` green (Postgres up)

## Out of scope
- A dedicated antenna-range overlay (separate follow-up).
- Per-tier speeds (speed stays mode-based, matching current straight-line behavior).
- Any persistence schema change (none needed).
