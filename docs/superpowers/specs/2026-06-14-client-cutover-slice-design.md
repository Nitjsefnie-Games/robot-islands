# Design spec — Server migration slice 4: Client cutover

**Date:** 2026-06-14
**Status:** Approved for planning (owner: "finish slices 4 and 5 in-place")
**Part of:** the server-authoritative migration (TODO.md). **Slice 4 of 5.**
Builds on slices 1 (auth), 2 (runtime+persistence), 3 (transport+intent protocol).

---

## Context

Slices 1–3 stood up an authoritative server: accounts, per-account state in
Postgres with offline catch-up, and a WebSocket intent protocol. The browser
client still runs its **own** local economy loop and mutates local state. Slice 4
**cuts the client over**: it authenticates, connects the WS, renders from the
**server's authoritative state**, and sends **intents** instead of mutating
locally. After this slice the server is the single source of truth for accounts
using it (TODO #1); SPEC §15.6 (pure client-side) is fully superseded.

## Decision

The server pushes the **full authoritative game state** as a `SaveSnapshot`; the
client **deserializes it into the same `WorldState`/`IslandState` objects its
renderers already consume**, so the render layer is essentially unchanged. The
client **removes its local `advanceIsland` tick** (the server owns ticks and
pushes fresh snapshots); **weather/day-night stay client-rendered from
`(seed, t)`** (TODO #5). Every UI mutation handler **sends an intent over the WS**
instead of calling a pure function locally, and applies the **authoritative
state returned in the ack** (no optimistic update — simplest correct model;
localhost latency is negligible, optimistic UX deferred).

**Documented UX defaults (owner delegated these):**
- **Auth gate**: a minimal email+password login/signup screen (reuses slice-1
  `/api/auth/*`) shown before the game; on success the cookie is set and the WS
  connects.
- **Update model**: authoritative-only. Intent → ack carries new state → replace
  the client replica → re-render. A short "applying…" affordance on in-flight
  intents; errors surface a toast and leave state unchanged.
- **Live progress**: the server pushes a fresh snapshot on a periodic tick (so
  inventories visibly advance) and after each intent. The client also runs a
  local render-only smoothing for deterministic systems (weather/day-night).
- **Offline catch-up**: on connect, the server's `loadAndCatchUp` has already
  integrated the gap; the client just renders the caught-up state (an
  offline-summary toast is a nice-to-have, deferred).
- **Import/export save buttons**: **removed** (TODO #8) — saves are server-side.

## Dependencies (must land first — sequenced in the plan)

1. **All 30 intents wired** (follow-up #13): the client has ~30 mutation points;
   any unwired one would get `unknown intent`. A clean cutover needs the full set
   (the 9 core from slice 3 + the 21 remaining). **This is slice-4 prerequisite
   work**, done server-side first.
2. **Full-fidelity projection**: slice 3's `projectGame` is a minimal summary.
   Slice 4 needs the client to receive the **complete** authoritative state. The
   simplest, lowest-divergence choice: the server sends the **serialized
   snapshot** (`serializeWorld(world, islandStates, now, now)`) and the client
   `deserializeWorld`s it — the exact round-trip the persistence layer already
   does. (A bespoke projection is rejected: it would duplicate the snapshot
   shape and risk drift with the renderers.)

## Architecture

### Server side
- **Snapshot push**: the WS sends `{type:'state', snapshot}` to the connected
  client (a) immediately on connect (post-`loadAndCatchUp`), (b) after each
  accepted intent (replace the slice-3 `projection` in the ack with the full
  serialized snapshot, or send a follow-up `state` message), and (c) on a
  periodic server tick.
- **Periodic tick**: a per-connection (or per-account) interval at
  `ECONOMY_TICK_MS`-scale that runs `loadAndCatchUp` (advancing production) and
  pushes the new snapshot, so the client sees inventories tick without acting.
  (Server owns the cadence — the `ECONOMY_TICK_MS` seam.)
- **Ack shape** extends slice-3: `{seq, ok, snapshot?}` (snapshot on success) or
  `{seq, ok:false, error}`.

### Client side
- **`server-client.ts`** (new, pure-ish transport): opens the WS, exposes
  `sendIntent(type, payload): Promise<Ack>` (correlates by `seq`), and an
  `onState(snapshot => …)` callback. Reconnects on drop.
- **`main.ts` boot rewrite**: replace `loadWorld()`/`createNewGame()` +
  the local tick with: show auth screen → on auth, connect WS → receive initial
  `state` → `deserializeWorld` → build the render layers from it (the existing
  `renderOceanFromState`/`renderIslandLayer`/etc., unchanged) → on each `state`
  message, update the in-memory `worldState`/`islandStates` and refresh
  renderers/HUD. **Delete the `shouldTick`/`advanceIsland` block** and the IDB
  `saveWorld` interval.
- **`auth-ui.ts`** (new): the login/signup screen calling `/api/auth/*`.
- **Intent dispatch in UI panels**: each mutation handler (placement-ui,
  routes-ui, drones launch, skill-tree, settlement, orbital, trade, inspector)
  swaps its local pure-fn call for `sendIntent(...)`; on the returned snapshot,
  the standard state-refresh path re-renders. The pure functions stay in `src/`
  (the server uses them) but are no longer called from the client mutation path.
- **Settings panel**: remove import/export save buttons + their plumbing.
- **Determinism**: weather/day-night keep sampling `(seed, t)` locally for smooth
  per-frame rendering; `seed` comes from the snapshot, `t` from wall-clock.

## What does NOT change
- The render layer (`ocean.ts`, `buildings.ts`, `grid.ts`, `*-overlay.ts`,
  `routes-renderer.ts`, the `*-ui.ts` *rendering* code) reads the same
  `WorldState`/`IslandState` shapes — only the *source* (server push, not local
  sim) and the *mutation* path (intents, not local calls) change.
- The pure `src/` layer (used by the server) is untouched here.

## Trust / scope notes
- This slice removes the client's authority; combined with slice 5 (hardening the
  pure fns that trust their caller) it closes the anti-cheat loop.
- `accept-trade` remains deferred (follow-up #15, server-deterministic offers) —
  the trade UI stays read-only/disabled in the client until that lands.

## Testing
- The client is render-coupled; pure-layer tests stay green. New pure-ish tests:
  `server-client.ts` envelope/seq correlation + reconnect (mockable WS);
  `auth-ui.ts` form→endpoint calls. The cutover boot path is verified by the
  Daedalus browser smoke (screenshot) against the live service + a manual
  login→play→reload→offline round-trip.
- Server: the snapshot-push + periodic-tick additions get integration tests
  (connect → receive state; intent → receive updated snapshot; tick advances
  inventory in a pushed snapshot).

## SPEC.md
- Mark **§15.6 fully superseded** (client is display + intent-sender; server owns
  state/persistence). Expand Appendix C with the push/tick model + the client
  architecture. Remove/annotate the import/export-save spec text (TODO #8).

## Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Unwired intent breaks a client action mid-cutover | HIGH | Wire all 30 intents (dep #1) BEFORE rewiring the client; cutover per-panel only after its intents exist. |
| Sending the full snapshot every tick is heavy | MED | localhost/single-user now; snapshot is the same blob IDB stored. Optimize later (deltas) — a tracked follow-up, not this slice. |
| Renderers assumed local mutation timing (e.g. read-after-mutate) | MED | Authoritative model: re-render from each pushed snapshot; per-panel smoke after cutover catches stale reads. |
| Removing the local tick breaks weather/day-night anchoring | MED | Keep the `(seed,t)` local render path; only the economy `advanceIsland` loop is removed. |
| Auth screen / WS reconnect edge cases | MED | `server-client.ts` reconnect + auth-expiry → re-show login; tested. |
| Huge blast radius (main.ts + ~10 UI panels) | HIGH | Sequence: deps → transport+boot → per-panel intent swaps one at a time (each green) → settings/save removal → SPEC. |

## Out of scope (named)
- Optimistic client updates / delta sync (future; authoritative-full-snapshot now).
- Multi-client broadcast fan-out / real-time co-op (server pushes to the acting connection; multi-device is TODO Appendix B, later).
- accept-trade UI (until follow-up #15).
- nginx public exposure of the WS/API (deployment; the client talks to the local service in dev via the existing proxy path — wire when exposing).
- Slice 5 hardening (separate slice).
