# Server Migration Slice 3 — Transport + Intent Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** An authenticated WebSocket that carries player intents; the server validates each by re-running the existing pure entry function on authoritative state, persists on success, and returns an ack + projection. Anti-cheat core. Client not cut over (slice 4).

**Architecture:** `server/src/game/intents.ts` (dispatch table: type → handler calling a pure `src/` fn), `intent-runner.ts` (loadAndCatchUp → apply → persist-or-reject), `ws.ts` (`@fastify/websocket`, cookie-auth on upgrade, serialize one in-flight intent/account). Reuses slice-2 runtime + persistence.

**Tech Stack:** Fastify + `@fastify/websocket`, `pg`, `tsx`, vitest. Builds on slices 1–2.

**Spec:** `docs/superpowers/specs/2026-06-14-transport-intent-protocol-slice-design.md` (read it — the 30-intent catalog, envelope, trust-surface notes, and risks are there; this plan does not repeat them).

---

## Routing
- **Task 1 (mechanism + reference intent)** → **opus** implementer: WS auth-on-upgrade, runner with no-partial-persist guarantee, and `place-building` wired as the reference. Judgment-heavy (failure-without-persist, WS auth, serialization). Deviate authority: adapt to the real pure-fn signatures; preserve the envelope/ack contract + the "rejected intent persists nothing" invariant.
- **Task 2 (8 more core intents)** → **opus** implementer: each needs reading the pure fn's real signature + adding an authoritative affordability/legality pre-check. Follow Task 1's established pattern.
- **Task 3 (SPEC.md)** → kimi/haiku.

The 21 non-core intents are a separate tracked follow-up (task #created), NOT in this plan.

---

## Verified inputs (from the slice-3 design audit)
The 9 core intents and their pure entry functions (read each function's actual signature before wiring — args listed are what the player supplies; the function applies cost/mutation):

| Intent | Pure entry | Player args | Spends |
|---|---|---|---|
| place-building | `src/placement.ts:placeBuilding` | islandId, defId, x, y, rotation | yes |
| demolish-building | `src/placement.ts:demolishBuilding` | islandId, buildingId | refunds |
| cancel-construction | `src/placement.ts:cancelConstruction` | islandId, buildingId | refunds |
| upgrade-building | `src/placement.ts:applyUpgrade` | islandId, buildingId | yes |
| set-active-floors | `src/placement.ts:setBuildingActiveFloors` | islandId, buildingId, disabledFloors | no |
| accept-trade | `src/trade.ts:applyOffer` | islandId, offerId | yes |
| dispatch-drone | `src/drones.ts:dispatchDrone` | islandId, originX, originY, dirX, dirY, fuelLoaded | yes |
| create-route | `src/routes.ts:createRouteFromBuilding` | fromIslandId, toIslandId, buildingId, filterResource? | no |
| unlock-skill-node | `src/skilltree.ts:buyNode` | islandId, nodeId | yes (SP) |

Slice-2 reusables: `loadAndCatchUp(pool,userId,now)→{world,islandStates}|null` (`server/src/game/runtime.ts`), `saveSnapshot(pool,userId,snapshot)` + `loadSnapshot` (`server/src/game/persistence.ts`), `serializeWorld(world,islandStates,now,now)` (`src/persistence.ts`), `projectGame({world,islandStates})` (`server/src/game/projection.ts`), `makeAuthGuard`/the cookie→session check (`server/src/auth/guard.ts`, `server/src/auth/sessions.ts:findValidSession`, `server/src/crypto/token.ts:hashToken`, `server/src/auth/cookie.ts:SESSION_COOKIE`).

---

## Task 1: WS transport + intent runner + `place-building` reference

**Route:** opus implementer. **Files:** create `server/src/game/intents.ts`, `server/src/game/intent-runner.ts`, `server/src/game/ws.ts`, `server/src/game/intent-runner.test.ts`, `server/src/game/ws.test.ts`; modify `server/src/app.ts`, `server/package.json` (add `@fastify/websocket`).

**Contract to honor (do not deviate from these):**
- **Envelope** (client→server): `{ type: string, payload: object, seq: number }`. **Ack** (server→client): `{ seq, ok: true, projection }` or `{ seq, ok: false, error: string }`.
- **Runner** `applyIntent(pool, userId, envelope, now): Promise<Ack>`:
  1. `game = await loadAndCatchUp(pool, userId, now)`; if null → `{ok:false, error:'no game'}`.
  2. `handler = INTENTS[envelope.type]`; if missing → `{ok:false, error:'unknown intent'}`.
  3. `const result = handler.apply(game, envelope.payload, now)` — the handler returns `{ok:true}` or `{ok:false, error}`. **It must NOT throw for an illegal/unaffordable request — it pre-checks and returns ok:false.**
  4. If `ok:false` → return it; **persist NOTHING** (the in-memory `game` is discarded — never call saveSnapshot).
  5. If `ok:true` → `await saveSnapshot(pool, userId, serializeWorld(game.world, game.islandStates, now, now))`; return `{ok:true, projection: projectGame(game)}`.
  - No-partial-persist invariant: a rejected or throwing handler must leave the stored `saves` row byte-identical. (If a handler throws unexpectedly, the runner catches it, returns `{ok:false,error}`, and persists nothing.)
- **Dispatch table** `INTENTS: Record<string, { apply(game, payload, now): {ok:true}|{ok:false,error:string} }>` in `intents.ts`. Each handler: validate payload shape; resolve `islandId`→state from `game`; **pre-check affordability/legality against authoritative state** (the design §6 trust-surface note); call the pure fn; return ok. Where the pure fn already self-validates and signals failure, use that; where it trusts the caller, add the pre-check here.
- **`place-building` handler** (the reference): look up the island state, read `placeBuilding`'s real signature in `src/placement.ts`, derive the placement cost authoritatively, verify the island inventory covers it AND placement is legal (mask/adjacency as `placeBuilding`/its validators expose), then apply. Reject (ok:false) if unaffordable/illegal — assert the stored save is unchanged in the test.
- **`ws.ts`**: register an `@fastify/websocket` route at `/api/game/ws`. On upgrade, authenticate via the `ri_session` cookie using the SAME cookie→session resolution as `makeAuthGuard` (factor a shared `resolveSession(pool, req)` helper out of `guard.ts` if needed so HTTP + WS share it); reject the upgrade (close) if unauthenticated. Per connection, parse each message as an envelope, call `applyIntent`, send the ack JSON. **Serialize**: queue messages so only one `applyIntent` runs at a time per connection (await the previous before the next) — prevents two intents racing the same `saves` row.

**Tests (`intent-runner.test.ts`, `ws.test.ts`):**
- runner: unknown intent → `ok:false`; no game → `ok:false`; a legal `place-building` → `ok:true`, projection reflects the new building, `saves` advanced; an unaffordable `place-building` → `ok:false`, `loadSnapshot` byte-identical to before.
- ws: unauthenticated upgrade rejected; authenticated client (signup → cookie) sends a `place-building` envelope, receives a matching-`seq` `ok:true` ack with projection; an unaffordable intent → `ok:false` ack; two envelopes sent back-to-back both ack in order and the save isn't corrupted.

**Steps:** TDD each (write failing test → run → implement → run → commit). Add `@fastify/websocket` to `server/package.json` deps and `npm install` first. Commit per logical unit (dep+ws skeleton; runner+intents+place-building; tests). Each commit green (`npm test -w server`). Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

**Gate:** `npm run build -w server` clean; `npm test -w server` green; root `npm test` green from a clean DB.

---

## Task 2: Wire the remaining 8 core intents

**Route:** opus implementer. **Files:** extend `server/src/game/intents.ts` + `intent-runner.test.ts` (or a new `intents.test.ts`).

For EACH of: `demolish-building`, `cancel-construction`, `upgrade-building`, `set-active-floors`, `accept-trade`, `dispatch-drone`, `create-route`, `unlock-skill-node`:
- Read the pure entry function's real signature in `src/` (table above).
- Add a dispatch-table handler following Task 1's pattern: payload validation, authoritative resolution + affordability/legality pre-check, call the pure fn, return `{ok}`.
- Add a test pair: a legal call applies + mutates the expected authoritative state (assert via projection or reloaded snapshot); an illegal/unaffordable call → `ok:false` + stored save unchanged.

**Per-intent notes:**
- `accept-trade`/`applyOffer`: validate the offer exists in authoritative runtime state and the give-side inventory suffices (TODO-flagged sensitive) before applying.
- `dispatch-drone`/`dispatchDrone`: validate fuel grade/amount present in origin inventory; the drone is added to `world.drones` (assert it appears).
- `unlock-skill-node`/`buyNode`: validate `unspentSkillPoints` covers the path cost; assert node added + points deducted.
- `set-active-floors`: no cost; validate the floor count is in range; assert `disabledFloors` set + storage caps adjusted.
- refunding intents (`demolish`, `cancel-construction`): assert resources credited and the building removed/job dequeued.

**Gate:** `npm run build -w server` clean; `npm test -w server` green (now ~9 intents × 2 cases + mechanism); root `npm test` green from clean DB. Commit (one per intent or a small batch), trailer as above.

---

## Task 3: SPEC.md Appendix C — intent protocol

**Route:** kimi/haiku. **Files:** modify `SPEC.md`.

- [ ] Append to Appendix C: the intent protocol (WS envelope `{type,payload,seq}`, ack shape, validate-by-re-running-pure-rules, the 30-intent catalog reference to the design doc, determinism-as-bandwidth so weather/day-night aren't sent). No simulation-mechanic edits.
- [ ] `npm test` (root) still green. Commit, trailer `Co-Authored-By: Kimi K2.7 Code <noreply@kimi.com>`.

---

## Self-Review (plan author)
- **Coverage:** transport+envelope+runner+ws → Task 1; the 9 core intents → Tasks 1–2; SPEC → Task 3. The 21 non-core intents are explicitly a tracked follow-up (not this plan). Trust-surface pre-checks per intent → Tasks 1–2 (design §6); deeper pure-fn hardening → slice 5.
- **Invariants pinned:** envelope/ack contract; no-partial-persist on reject; one-in-flight-intent-per-connection; WS auth shares the cookie→session check with HTTP.
- **Why opus, not kimi:** each handler must read a real pure-fn signature and add an authoritative legality pre-check where the fn trusts its caller (design HIGH risk). That's judgment, not transcription — kimi would faithfully wire an under-validating call. Opus with deviate authority per the SDD patch.
- **Reuse:** loadAndCatchUp/saveSnapshot/serializeWorld/projectGame/cookie-session all exist from slices 1–2; no reimplementation.
