# Plan: One-way path-drawn drones recovered via remote Antenna range (#117)

## Goal

Make **path-drawn drone flights one-way** (no forced return). The drone flies the
drawn path and ends at the terminus. Its buffered telemetry is recovered only if
the terminus is inside an Antenna's signal range; otherwise the data is forfeit.
This roughly doubles a drawn drone's reach (no return leg budgeted) and makes the
drawn path a deliberate "fly the data into a remote antenna" act.

Straight-line (non-path-drawn, T1–T4) drones are **unchanged** — they remain
round-trip.

## Why this is contained to the pure layer

- `dispatchDrone` already receives `waypoints` through the mutation gateway
  (`mutation-gateway.ts:547`) and the server intent (`server/src/game/intents.ts:460`)
  unchanged. "One-way" is derived from `waypoints.length >= 2` **inside** the pure
  `dispatchDrone`, so **no gateway / intent / server signature change** is needed —
  the server re-runs the same pure code and stays byte-consistent.
- `SerializedDrone = Omit<Drone,'scanBuffer'>`. We add **no new Drone field**
  (one-way is implied by `waypoints`), and the new `'stranded'` status is an
  **additive union value** old saves never produce. ⇒ **No persistence migration**
  (SCHEMA_VERSION stays 25).

Surface = `src/drones.ts` + `src/drones.test.ts` + `SPEC.md`. (Plus a UI range-hint
note, see Phase 4 — optional.)

## Design decisions (locked)

1. **Trigger:** `isPathDrawn` (`waypoints.length >= 2`) ⇒ one-way. Straight-line ⇒ round-trip (unchanged).
2. **Range/timing (dispatchDrone, path-drawn branch ~`drones.ts:494-514`):**
   - Range check becomes one-way: reject when `totalPathLength > fuelLoaded * efficiency`
     (was `totalPathLength * 2 > ...`). Reason string stays `'path-too-long'`.
   - `outboundTiles = totalPathLength` (unchanged).
   - `travelSec = totalPathLength / speed` (was `(totalPathLength * 2) / speed`).
   - `expectedReturnTime = nowMs + travelSec*1000` — now means "arrival at terminus."
3. **Position (`droneCurrentPosition`, waypoints branch ~`drones.ts:965-973`):**
   one-way drones do **not** fold back. For path-drawn: `total = outboundTiles`
   (not `2*outboundTiles`); clamp travelled to `outboundTiles`; position =
   `positionAlongPolyline(d.waypoints, clamped)`. The drone stops at the final waypoint.
4. **Tick reveal (`tickDrones` ~`drones.ts:753-800`):** for path-drawn, emit only the
   **outbound** waypoint crossings (no inbound/reverse-retrace crossings). The terminus
   (final waypoint) is the apex.
5. **Terminus handling (`tickDrones` ~`drones.ts:869-918`):** when `nowMs >= expectedReturnTime`:
   - Run the existing §2.6 weather-destruction decision **unchanged** (precomputed
     `doomedAtMs`, else legacy roll). If destroyed ⇒ `status='lost'`, buffers cleared
     (existing behavior).
   - If it survives **and is path-drawn (one-way):**
     - Compute terminus position (final waypoint).
     - If terminus is in any antenna signal range (`pointInSignalRange(ranges, …)`):
       `flushDroneBuffers(...)` (recover data), then `status='stranded'`.
     - Else: clear `scanBuffer` + `darkModeDiscoveries` (data forfeit), `status='stranded'`.
     - Push to a new `stranded` result array (see Phase 1 interface change).
   - If it survives and is **straight-line:** unchanged — flush + `status='returned'`.
6. **Status enum:** add `'stranded'` to `Drone.status` union. Treat it as terminal
   everywhere `'lost'`/`'returned'` are treated terminal — specifically the early
   `if (d.status === 'lost' || d.status === 'returned')` guard at ~`drones.ts:723`
   must also skip `'stranded'`.
7. **Pad cap:** no change needed — the in-flight count at ~`drones.ts:442-448` already
   counts only `status === 'active' || undefined`, so `'stranded'` frees the slot.
8. **Weather path for the destruction roll:** for one-way path-drawn, the weather
   sampling path is the **outbound polyline only** (no return leg). Verify
   `buildWeatherPath` is invoked with the one-way trajectory at BOTH the dispatch-time
   roll (sets `doomedAtMs`) and the legacy return-time roll, so they stay in lockstep.
   (If `buildWeatherPath` currently appends a return leg for waypoint drones, make it
   one-way when path-drawn.)
9. **Mid-flight flush** (Flush trigger A, ~`drones.ts:861-866`) is kept as-is — a
   one-way drone that crosses an antenna's range mid-path still flushes there.

## Phases / tasks (TDD — write the failing test first, then code)

### Phase 1 — status + result interface
- Add `'stranded'` to `Drone.status`. Add `stranded: Drone[]` to `TickDronesResult`
  (additive; existing callers ignore it). Initialize `const stranded: Drone[] = []`
  and return it.
- Make the terminal-status guard at ~`drones.ts:723` include `'stranded'`.

### Phase 2 — one-way dispatch math
- Test: a path-drawn drone with fuel that covers one-way-but-not-round-trip now
  **dispatches OK** (previously rejected `'path-too-long'`); `expectedReturnTime`
  reflects one-way `travelSec`; `outboundTiles == totalPathLength`.
- Test: a straight-line drone is **unchanged** (round-trip range + timing).
- Implement the dispatchDrone changes (decision 2) + weather-path one-way (decision 8).

### Phase 3 — one-way position + terminus tick
- Test: `droneCurrentPosition` for a path-drawn drone past `expectedReturnTime`
  returns the **final waypoint** (not folded back to origin).
- Test: one-way drone whose terminus IS inside an antenna's range → after the tick
  that crosses `expectedReturnTime`: `status==='stranded'`, buffered cells flushed
  into `world.revealedCells`, drone in `result.stranded`, pad slot freed (a second
  dispatch from the same pad now succeeds).
- Test: one-way drone whose terminus is OUT of antenna range → `status==='stranded'`,
  **no** cells flushed, buffer empty.
- Test: one-way drone doomed by weather mid-path → still `status==='lost'` (weather
  wins over stranding), buffers cleared.
- Implement decisions 3, 4, 5, 6.

### Phase 4 — (optional, do if time permits) UI range hint
- The drawn-path range hint in `drones-ui-helpers.ts` / `drones-ui.ts` assumes
  round-trip (`/2`). For path-drawn, the usable reach is now the full one-way length.
  Correct the hint text/computation so the player sees the true one-way reach.
- Do **not** build a new antenna-range overlay in this pass (follow-up).

### Phase 5 — SPEC.md
- Update the drone section (§11.5 path-drawn / §11.6 telemetry / §2.6) to state:
  path-drawn flights are one-way; reach is the full drawn-path length (no return
  budget); telemetry is recovered only if the terminus lies in an Antenna signal
  range, else forfeited; new terminal status `stranded`. Code and spec move together.

## Verification gate (must pass before merge)
- `npx vitest run src/drones.test.ts` green (plus any other suite touching drones).
- `cd server && npx tsc --noEmit` clean (server imports the pure drones.ts).
- Root `npx tsc -b` / `npm run build` clean.
- `npm test` (client + server projects) green — requires Postgres up; if PG is down
  that's an environment gap, not a code failure (note it).

## Out of scope (explicit)
- The #116 Path/Simple-click toggle (separate issue). Here, path-drawn ⇒ one-way is
  the behavior; no per-launch toggle.
- A dedicated antenna-range map overlay (follow-up).
- Any gateway / server intent / persistence schema change (not needed — see above).
