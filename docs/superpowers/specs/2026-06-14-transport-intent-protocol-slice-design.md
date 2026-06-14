# Design spec — Server migration slice 3: Transport + intent protocol

**Date:** 2026-06-14
**Status:** Approved for planning
**Part of:** the server-authoritative migration (TODO.md). **Slice 3 of ~5.**
Builds on slice 1 (auth/sessions) and slice 2 (server runtime + `saves` + `loadAndCatchUp`).

---

## Context

Slices 1–2 gave us accounts and a server that owns/persists game state with
offline catch-up. Slice 3 adds the **two-way channel**: the client sends
**intents** (place, spend, dispatch, trade, …); the server **validates each
against the same pure rules**, applies it authoritatively, persists, and pushes
back the updated **projection**. This is the anti-cheat core (TODO #1): the
client can ask, but only the server's pure-function outcome is real. The browser
client is still NOT cut over (slice 4) — slice 3 is verified server-side
(integration tests + a scripted WS client).

## Decision

Add an authenticated **WebSocket** endpoint (`@fastify/websocket`) that carries a
small **intent envelope**. A server-side **intent dispatch table** maps each
intent `type` to the **existing pure entry function** (e.g. `place-building` →
`placeBuilding`), runs it against the account's **authoritative** live game
(loaded via slice-2 `loadAndCatchUp`), persists the result, and broadcasts the
new projection. **Validation = re-running the pure function on authoritative
state**: the client's numbers are never trusted; the pure function recomputes
cost/legality from server state and the server reports success/failure from its
outcome.

**Scope of THIS slice:** the transport + envelope + dispatch/validate/persist/
broadcast **mechanism**, wired end-to-end for a **core subset** of intents, with
**all 30 intents cataloged** (§5) so the rest are a mechanical follow-up. Full
projection fidelity and the client cutover are slice 4; the deeper trust-surface
hardening of pure functions that under-validate is slice 5.

**Deliberately NOT here:** client cutover (slice 4); hardening the `as unknown
as` casts + functions that trust their caller (slice 5); wiring all 30 intents
(core subset now, rest tracked); a full client-fidelity projection.

---

## 1. Background — verified intent surface

An audit of `src/` enumerated **30 player-initiated state-mutating actions** (the
wire intents) and the **automatic/tick** functions that must NOT be intents
(`advanceIsland`, `tickDrones`, `tickRoutes`, `tickVehicles`, `tick*` orbital,
`tickTradeOffers`, `performMerge`, …) — those are driven by the server's tick
loop (slice 2's `loadAndCatchUp` + the future cadence loop), never by the client.

Every mutating action already has a **pure entry function** that applies it to
state (and most already deduct cost / check affordability internally). The
server reuses these unchanged (same cross-workspace import mechanism slice 2
established). The intents and their entry points are cataloged in §5.

## 2. Decisions captured

| Decision | Choice | Rationale |
|---|---|---|
| Transport | WebSocket (`@fastify/websocket`) | Bidirectional, low-latency, push projections; matches a live game. |
| Auth on the socket | reuse the slice-1 session cookie | One identity; `makeAuthGuard` logic on the WS upgrade. |
| Intent envelope | `{ type, payload, seq }` JSON | Minimal; `seq` lets the client correlate the ack. |
| Validation model | re-run the pure entry function on authoritative state | The pure rule IS the validator; client numbers never trusted (anti-cheat). |
| Apply path | load via slice-2 `loadAndCatchUp` → apply intent → persist → broadcast | One authoritative state per account; durable after each intent. |
| Failure reporting | structured `{ ok:false, error }` ack; state unchanged/not persisted | A rejected intent must not mutate or persist. |
| Projection | extend slice-2 `projectGame` incrementally | Enough to prove changes land; full fidelity is slice 4. |
| Intent coverage | mechanism + core subset wired; all 30 cataloged | Keeps the slice shippable; rest is mechanical. |

## 3. Architecture — new files (`server/src/game/`)

| File | Responsibility |
|---|---|
| `server/src/game/intents.ts` | The intent **catalog + dispatch table**: `type` → `{ apply(game, payload, now), cost? }`. Each entry calls a pure `src/` function. Pure-ish (no DB/WS). |
| `server/src/game/intent-runner.ts` | `applyIntent(pool, userId, intent, now)`: `loadAndCatchUp` → look up handler → apply on authoritative game → on success persist + return new projection; on failure return error, persist nothing. |
| `server/src/game/ws.ts` | `@fastify/websocket` route `/api/game/ws`: authenticate the upgrade (session cookie), receive envelopes, call `intent-runner`, send acks/projections. Serializes per-connection (one in-flight intent per account). |
| `server/src/app.ts` | Register `@fastify/websocket` + the ws route. |
| tests | `intents.test.ts` (each wired intent: legal applies + mutates state, illegal/unaffordable rejected + no mutation), `ws.test.ts` (auth required; envelope round-trip; ack shape; rejected intent leaves save unchanged). |

Separation: `intents.ts` is the pure dispatch map (testable without DB/WS);
`intent-runner.ts` owns DB+orchestration; `ws.ts` is transport only.

## 4. Intent envelope & flow

```
client → server:  { "type": "place-building", "payload": { islandId, defId, x, y, rotation }, "seq": 42 }
server:           game = loadAndCatchUp(pool, userId, now)        // authoritative
                  handler = INTENTS["place-building"]
                  result = handler.apply(game, payload, now)      // re-runs placeBuilding on server state
                  if result.ok:  saveSnapshot(...); broadcast projection
                  else:          nothing persisted
server → client:  { "seq": 42, "ok": true,  "projection": {...} }
            or:   { "seq": 42, "ok": false, "error": "insufficient resources" }
```

- **Authoritative legality**: the handler calls the pure function on server
  state. If the pure function would over-spend or place illegally, the handler
  detects the failure (return value, thrown guard, or a pre-check the function
  exposes) and reports `ok:false` WITHOUT persisting. Where a pure function
  currently *trusts its caller* (doesn't self-validate affordability), §6 marks
  it for slice-5 hardening; for slice 3 the handler adds the minimal pre-check.
- **One in-flight intent per account**: `ws.ts` serializes intents per
  connection so two intents can't race the same `saves` row.
- **Determinism-as-bandwidth (TODO #5)**: weather/day-night are NOT sent; the
  client renders them from `(seed, t)`. The projection carries only
  non-deterministic authoritative state.

## 5. Intent catalog (all 30 — wire targets)

Core subset wired end-to-end THIS slice (the TODO's place/spend/dispatch/trade +
the most-used): `place-building`, `demolish-building`, `cancel-construction`,
`upgrade-building`, `set-active-floors`, `accept-trade`, `dispatch-drone`,
`create-route`, `unlock-skill-node`. The remaining 21 are wired via the same
dispatch pattern as a tracked follow-up.

| Intent | Pure entry (`src/…`) | Spends? | Wired this slice |
|---|---|---|---|
| place-building | `placement.ts:placeBuilding` | yes | ✅ |
| demolish-building | `placement.ts:demolishBuilding` | no (refunds) | ✅ |
| cancel-construction | `placement.ts:cancelConstruction` | no (refunds) | ✅ |
| cancel-queued-upgrade | `placement.ts:cancelConstruction` (LIFO) | no | follow-up |
| upgrade-building | `placement.ts:applyUpgrade` | yes | ✅ |
| relocate-building | `placement.ts:relocateBuilding` | yes | follow-up |
| set-active-floors | `placement.ts:setBuildingActiveFloors` | no | ✅ |
| set-force-run | building flag (`b.forceRun`) | no | follow-up |
| relabel-cargo | `placement.ts:applyRelabelStorageCap` | no | follow-up |
| convert-to-servitor | `buildings.ts:convertToServitor` | yes | follow-up |
| expand-island | `land-reclamation.ts:expandIsland` | yes | ✅ |
| accept-trade | `trade.ts:applyOffer` | yes | ✅ |
| reject-trade | offer removal + cooldown bump | no | follow-up |
| dispatch-drone | `drones.ts:dispatchDrone` | yes | ✅ |
| fire-t4-pulse | `drones.ts:firePulse` | yes | follow-up |
| create-route | `routes.ts:createRouteFromBuilding` | no | ✅ |
| delete-route | `route.draining = true` | no | follow-up |
| set-route-cargo / mode / weight / floor-pct / reorder | `routes.ts:*` + route fields | no | follow-up |
| unlock-skill-node | `skilltree.ts:buyNode` | yes (SP) | ✅ |
| buy-keystone | `skilltree.ts:buyKeystone` | yes (SP) | follow-up |
| bind-crystal / unbind-crystal | `skilltree.ts:bindCrystal/unbindCrystal` | yes/refund | follow-up |
| tier-reset | `tier-reset.ts:executeTierReset` | yes | follow-up |
| dispatch-settler | `settlement.ts:dispatchVehicle` | yes | follow-up |
| settle-via-spacetime | `settlement.ts:settleViaSpacetimeAnchor` | yes | follow-up |
| rename-island | `world.ts:renameIsland` | no | ✅ |
| edit-biome | `universe-editor.ts:editIslandBiome` | yes | ✅ |
| construct-island | `artificial-island.ts:constructIsland` | yes | ✅ |
| launch-satellite | `orbital.ts:launchSatellite` | yes | follow-up |
| upgrade-spaceport | `orbital.ts:upgradeSpaceport` | yes | follow-up |
| move-satellite | `orbital.ts:requestSatMove` | yes (sat fuel) | follow-up |
| dispatch-repair-drone | `orbital.ts:dispatchRepairDrone` | yes | follow-up |

(The "follow-up" intents are a mechanical extension task: one dispatch-table
entry + handler + test each, no new mechanism. Tracked, not dropped.)

## 6. Trust surface (feeds slice 5)

- Several pure functions **deduct cost only if the caller checked affordability**
  (the client UI did that pre-server). Server-side, the handler must **pre-check
  affordability from authoritative inventory** before applying, or the function
  must be hardened to self-reject. Slice 3 adds the minimal handler pre-check for
  the wired intents; slice 5 hardens the pure functions themselves + the
  `as unknown as` readonly-mutation casts (TODO hardening note).
- `accept-trade` and the XP path are explicitly called out by TODO as sensitive —
  the handler validates the offer exists in authoritative state and the give-side
  inventory suffices before applying.

## 7. Testing (vitest, against `robot_islands_test`)

- **Per wired intent** (`intents.test.ts`): a legal intent applies and mutates
  the expected authoritative state; an illegal/unaffordable intent is rejected
  and leaves state + `saves` unchanged.
- **WS** (`ws.test.ts`): unauthenticated upgrade rejected; a signed-in client
  sends an envelope and gets a matching `seq` ack with a projection; a rejected
  intent yields `ok:false` and the stored snapshot is byte-unchanged; two queued
  intents apply in order (no `saves` race).
- Reuse slice-1/2 helpers (`buildTestApp`, a session cookie, `loadSnapshot`).

## 8. SPEC.md handling

Expand **Appendix C** with the intent protocol (envelope, validate-by-re-running
pure rules, the 30-action catalog reference, determinism-as-bandwidth). No
simulation-mechanic change, so no §-by-§ mechanic edits.

## 9. Verification checklist

- `npm run build -w server` clean; `npm test -w server` green (intents + ws suites + prior).
- Root `npm test` green from a clean DB.
- Live: a scripted WS client (or `websocat`) authenticates, sends `place-building`, receives `ok:true` + projection; sends an unaffordable intent, receives `ok:false`; `psql` shows the save advanced only for the accepted intent.

## 10. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Pure functions that trust caller → server applies an illegal intent | HIGH | Handler pre-checks affordability/legality from authoritative state before apply; rejected intents persist nothing; slice 5 hardens the functions. |
| Concurrent intents race the same `saves` row | MED | `ws.ts` serializes one in-flight intent per account; load→apply→persist is atomic per intent. |
| Detecting failure when a pure function mutates-then-returns-void | MED | Snapshot inventory/state before apply; if the function half-applied an illegal op, roll back by discarding the in-memory game (reload) and report error — never persist a partial. |
| WS auth on upgrade differs from HTTP guard | MED | Factor the cookie→session check so the WS upgrade and `makeAuthGuard` share it. |
| Scope creep wiring all 30 intents | LOW | Core subset only; rest tracked as a mechanical follow-up. |

## 11. Out of scope (named)

- **Client cutover to the WS projection** → slice 4.
- **Hardening pure functions that under-validate + `as unknown as` casts** → slice 5.
- **Wiring the 21 follow-up intents** → tracked mechanical extension.
- **Full client-fidelity projection** → slice 4.
- **Server fixed-cadence tick loop / live multi-client broadcast fan-out** → arrives with the client cutover; slice 3 broadcasts to the acting connection.
