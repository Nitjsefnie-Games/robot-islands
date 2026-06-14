# Design spec — Server migration slice 2: Server runtime + persistence

**Date:** 2026-06-14
**Status:** Approved for planning
**Part of:** the server-authoritative migration (TODO.md). **Slice 2 of ~5.**
Builds on slice 1 (auth service + user store, merged) — reuses its `users`
table, session guard, Fastify app, Postgres connection, and migration runner.

---

## Context

Slice 1 gave us accounts + sessions. Slice 2 makes the **server own game state**:
it hosts the existing **pure simulation layer** (`advanceIsland`, §15.3) and moves
persistence from the browser's IndexedDB to **Postgres**, keyed by account. This
is the **in-place port** strategy of TODO.md ("the pure layer ports as-is"), not a
rewrite. After this slice the simulation can run, persist, and offline-catch-up
entirely server-side; the **client is still untouched** (it keeps its own local
loop for now — the cutover to server state is slice 4).

> Note: a separate clean-room rewrite exists at `/root/islands`. This migration is
> the alternative **in-place** path on the original `/root/robot-islands/src`, per
> the goal set on this repo's TODO.md.

## Decision

Add a server **game runtime** that, per account, deserializes the account's
snapshot, advances `advanceIsland` to "now" (offline catch-up uses the same
event-driven integrator — a 24 h gap is one integrate call), and persists the
result to a **`saves`** table (one row per account, `snapshot jsonb`). The server
**reuses the pure functions from `src/persistence.ts`** (`serializeWorld`,
`deserializeWorld`, the `migrateV*` chain, `SUPPORTED_LOAD_VERSIONS`,
`SCHEMA_VERSION`) and `src/economy.ts` (`advanceIsland`) **unchanged**, imported
across the npm workspace. The server owns `ECONOMY_TICK_MS`.

**Deliberately NOT in this slice:** the intent/mutation protocol and WebSockets
(slice 3), the client cutover to server state (slice 4), trust-surface hardening
(slice 5), and the `world.ts`/`island.ts` pure/render split (TODO #6 — deferred;
the transitive PixiJS import is import-only and harmless headless).

---

## 1. Background — the seams (verified)

- `advanceIsland(state, nowMs)` (`src/economy.ts`) is the event-driven integrator;
  it is dt-agnostic (one frame ≡ 24 h catch-up) and **pixi-free**.
- `deserializeWorld(snapshot, nowWall, nowPerf)` → `{ world, islandStates: Map<id, IslandState> }`;
  `serializeWorld(world, islandStates, savedAt, savedAtPerf)` → `SaveSnapshot`
  (current `SCHEMA_VERSION = v24`). `loadWorld` walks `migrateV7→…→v24`.
- These live in `src/persistence.ts`, which transitively imports `src/world.ts`
  → `pixi.js`. **`scripts/profile-economy.ts` proves the whole chain imports and
  runs in Node** (`deserializeWorld` + `advanceIsland`, zero browser). PixiJS is
  loaded but never instantiated. We accept this for the slice.
- `ECONOMY_TICK_MS = 200` + `shouldTick` (`src/economy-clock.ts`) is the named
  cadence seam the server now owns.
- Slice 1 provides: `server/src/db.ts` (pg Pool), `server/src/migrate.ts`
  (numbered-SQL runner), `server/src/auth/guard.ts` (`makeAuthGuard` → `req.user`),
  `server/src/app.ts` (`buildApp`).

## 2. Decisions captured

| Decision | Choice | Rationale |
|---|---|---|
| Strategy | In-place port of `src/` | TODO.md decided input; reuse proven pure layer. |
| Save granularity | One `saves` row per account | Single-player world per account today. |
| Snapshot storage | `jsonb` column | Same `SaveSnapshot` shape the client serializes; queryable. |
| Reuse vs reimplement | Import pure `src/` functions unchanged | Zero divergence risk; the whole point of "ports as-is". |
| Pixi transitive import | Accept (defer the split) | Proven harmless headless; split is TODO #6, out of scope. |
| Tick model (this slice) | Lazy: catch-up on access + periodic autosave | No live clients yet; a fixed-cadence loop is slice 3/4. |
| Authoritative clock | `Date.now()` (wall) for both nowWall/nowPerf | Matches `profile-economy.ts`; offline gap = elapsed real time. |
| HTTP surface | `new` + `state` only (no mutations) | Mutations/intents are slice 3. |
| Import/export save | Dropped | TODO #8 — saves are server-side only now. |

## 3. Data model — migration `0002_saves.sql`

```sql
CREATE TABLE saves (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  snapshot       jsonb NOT NULL,            -- a full SaveSnapshot (client shape)
  schema_version integer NOT NULL,          -- snapshot.v at write time
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

One save per account (PK = user_id). `snapshot` is the exact `SaveSnapshot`
object `serializeWorld` produces (so the client's format and the server's are
identical — important for slice 4). `schema_version` is denormalized from
`snapshot.v` for cheap version queries / future bulk migrations.

## 4. Architecture — new files (`server/src/game/`)

| File | Responsibility |
|---|---|
| `server/src/game/persistence.ts` | Postgres save I/O + migration chain: `loadSnapshot`, `saveSnapshot`, `hasSave`. Wraps the **pure** `src/persistence.ts` migration logic against the DB instead of IDB. |
| `server/src/game/new-game.ts` | Build the initial `SaveSnapshot` for a fresh account (reuse the client's initial-world constructor — identified in the plan). |
| `server/src/game/runtime.ts` | `loadAndCatchUp(pool, userId, now)`: load → migrate → deserialize → `advanceIsland` all populated islands to `now` → reserialize → persist → return state. The per-account runtime entry point. |
| `server/src/game/projection.ts` | Minimal read-model: map `IslandState`s → a JSON summary (id, level, xp, key inventory) for `GET /api/game/state`. (Full projection is slice 3; this proves the loop.) |
| `server/src/game/routes.ts` | `POST /api/game/new`, `GET /api/game/state`, behind the auth guard. |

`buildApp` registers the game routes plugin (guarded). The pure `src/` imports
(`serializeWorld`, `deserializeWorld`, `migrate*`, `advanceIsland`,
`SCHEMA_VERSION`, `SUPPORTED_LOAD_VERSIONS`, types) are imported via the
workspace from `../../../src/*.js`.

## 5. Migration-chain reuse (no refactor needed — verified)

**Verified in source:** `deserializeWorld(snapshot, nowWall, nowPerf)` already
walks the entire `v7 → … → SCHEMA_VERSION` `migrateV*` chain *internally* at the
top of the function (`src/persistence.ts:869-920`), then throws if the result
isn't current. `loadWorld` is just an IDB wrapper around it. **The earlier idea
of extracting a `migrateSnapshotToCurrent` helper is therefore unnecessary and
dropped** — slice 2 makes **no change** to `src/persistence.ts` for migration.

`server/src/game/persistence.ts` simply:
1. Reads the `saves.snapshot` jsonb (a possibly-old-version `SaveSnapshot`).
2. Calls `deserializeWorld(snapshot, now, now)` — migration happens inside.

Migration logic stays **single-sourced** (the one copy in `deserializeWorld`),
used by both client (`loadWorld`) and server, with zero new code.

## 6. Time & offline catch-up

- On **save**: stamp `savedAt = savedAtPerf = Date.now()`.
- On **load**: call `deserializeWorld(snapshot, Date.now(), Date.now())`. The
  deserializer's `perfShift = nowPerf − snapshot.savedAtPerf` becomes the real
  elapsed time since the last save; each `IslandState.lastTick` is shifted so the
  next `advanceIsland(state, Date.now())` integrates exactly the offline gap.
- `loadAndCatchUp` then calls `advanceIsland(state, Date.now())` for every
  populated island and immediately re-serializes + persists, so the catch-up is
  durable. Same code path for a 1-second gap and a 30-day gap.

## 7. HTTP surface (`/api/game`, all behind the slice-1 auth guard)

| Method | Path | Success | Failure |
|---|---|---|---|
| POST | `/api/game/new` | 201 + summary (creates initial save) | 409 if a save exists |
| GET | `/api/game/state` | 200 + projection (loads, catches up, persists) | 404 if no save; 401 if unauthenticated |

No mutation endpoints this slice. (`POST /api/game/save` is internal — autosave
on a timer + after each catch-up; not a public route yet.)

## 8. Testing (vitest, against `robot_islands_test`)

- **Save roundtrip**: `saveSnapshot` then `loadSnapshot` returns an identical
  `SaveSnapshot` (deep-equal); `schema_version` column matches `snapshot.v`.
- **Migration on load**: store an older-version fixture snapshot, load → it is
  migrated to `SCHEMA_VERSION` and deserializes cleanly.
- **Offline catch-up**: store a snapshot whose `savedAt` is N hours ago, load →
  populated islands' inventories/xp advance (state changed vs the stored one);
  split-invariance sanity (load-at-T ≈ load-at-t then load-at-T).
- **New game**: `POST /api/game/new` creates a save; second call → 409.
- **State**: `GET /api/game/state` returns a projection for the account; 404
  before `new`; 401 unauthenticated (guard reused).
- **Pure-layer reuse smoke**: importing `serializeWorld`/`advanceIsland` from
  `src/` in the server build compiles and runs (no pixi instantiation).
- Tests use a real session cookie minted via the slice-1 signup route, or a
  helper that inserts a user + session directly.

## 9. SPEC.md handling

This slice **does** move persistence server-side, so:
- Expand **Appendix C** with the runtime + `saves` table + catch-up model.
- Annotate **§15.6** ("pure client-side"): mark it **superseded for state
  ownership** by the server migration (state + persistence now server-authoritative
  for accounts using the server), with a pointer to Appendix C. Per AGENTS.md,
  code and SPEC move together. (The client still runs locally until slice 4, so
  §15.6 is "superseded, cutover pending," not deleted.)
- If `migrateSnapshotToCurrent` is extracted (§5), update the persistence
  section + the migration tests accordingly.

## 10. Verification checklist

- `npm run build -w server` clean (server now imports `src/` pure modules).
- `npm test -w server` green (new game/runtime/persistence suites + slice-1 suites).
- Root `npm test` still green (any `src/persistence.ts` refactor keeps client tests green).
- Live: authenticated `POST /api/game/new` → 201; `GET /api/game/state` → 200 projection;
  re-`GET` after a simulated time gap shows advanced state; `psql` shows one `saves` row per account.

## 11. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| Importing `src/persistence.ts` drags PixiJS into the server bundle | LOW | Import-only, proven headless (profile-economy.ts); split deferred to TODO #6; document it. |
| (Removed) migration-helper extraction | — | Not needed: `deserializeWorld` already migrates internally; no `src/persistence.ts` change. |
| Snapshot jsonb shape drift between client serialize + server expectations | MED | Reuse the exact `serializeWorld` output; roundtrip test asserts identity. |
| Clock/perfShift mismatch yields wrong catch-up | MED | Stamp savedAt=savedAtPerf=Date.now(); load passes Date.now() for both; offline-catch-up test asserts advancement + split-invariance. |
| New-game constructor not cleanly reusable from `src/` | MED | Plan identifies the client's initial-world path; if browser-coupled, extract a pure builder (small, tested). |

## 12. Out of scope (named)

- **Intent/mutation protocol + WebSockets** → slice 3.
- **Client cutover to server state** → slice 4.
- **Trust-surface hardening** (`as unknown as` casts, trade/XP) → slice 5.
- **`world.ts`/`island.ts` pure/render split** → TODO #6, deferred.
- **Fixed-cadence server tick loop** → arrives with live clients (slice 3/4); this slice ticks lazily on access + autosave.
- **nginx exposure / client API wiring** → deployment/slice 4.
