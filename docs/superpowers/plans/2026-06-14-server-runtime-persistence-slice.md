# Server Migration Slice 2 — Server Runtime + Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server own game state — host the pure simulation (`advanceIsland`) and persist `SaveSnapshot`s to Postgres per account, with offline catch-up — reusing the pure `src/` functions unchanged. Client stays on its local loop (cutover is slice 4).

**Architecture:** New `server/src/game/` modules (persistence, new-game, runtime, projection, routes) reuse `src/persistence.ts` (`serializeWorld`/`deserializeWorld` — the latter migrates v7→v24 internally) and `src/economy.ts` (`advanceIsland`) across the npm workspace. A small pure `src/new-game.ts` is extracted from `main.ts`'s inline boot so client and server build a fresh world identically. The server runs via `tsx` (like `scripts/profile-economy.ts`) to import the cross-tree pure layer without `rootDir`/emit friction.

**Tech Stack:** TypeScript, Fastify, `pg`, `tsx`, vitest, Postgres. Builds on slice 1.

**Spec:** `docs/superpowers/specs/2026-06-14-server-runtime-persistence-slice-design.md`

---

## Verified grounding (from source — do not re-derive)

- `deserializeWorld(snapshot, nowWallMs, nowPerfMs)` (`src/persistence.ts:864`) walks the full `v7→…→v24` `migrateV*` chain **internally** (`:869-920`), then throws if not `SCHEMA_VERSION`. **No migration helper extraction needed.**
- `serializeWorld(world, islandStates, nowWallMs=Date.now(), nowPerfMs=performance.now()): SaveSnapshot` (`:745`). `SaveSnapshot` has `savedAt`/`savedAtPerf`.
- New-game state construction in `main.ts` (`:173`,`:947-973`) is: `makeInitialWorld(now)` → find `home` spec → `makeInitialIslandState` for `home` + every other `populated` spec → set `world.islandStates`. (`makeInitialWorld(nowMs)`, `makeInitialIslandState(spec, nowMs)` both in `src/world.ts`.)
- `src/persistence.ts` transitively imports `pixi.js` via `src/world.ts`; proven importable/runnable headless by `scripts/profile-economy.ts` (pixi loaded, never instantiated).
- Slice 1 provides: `server/src/db.ts` (`createPool`, `Pool`), `server/src/migrate.ts` (`runMigrations`, reads `server/migrations/*.sql`), `server/src/auth/guard.ts` (`makeAuthGuard`), `server/src/auth/users.ts` (`createUser`), `server/src/auth/sessions.ts` (`createSession`), `server/src/crypto/token.ts` (`generateToken`, `hashToken`), `server/src/app.ts` (`buildApp`, `AppOptions`), `server/src/test-helpers.ts` (`testPool`, `resetDb`, `buildTestApp`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/new-game.ts` (+ `.test.ts`) | **NEW pure module** — `createNewGame(nowMs)` extracted from `main.ts` |
| `src/main.ts` | Rewire fresh-game path to call `createNewGame` |
| `server/tsconfig.json`, `server/package.json`, `server/deploy/*` | Switch server to `tsx` runtime (cross-tree imports) |
| `server/migrations/0002_saves.sql` | `saves` table |
| `server/src/game/persistence.ts` (+test) | `loadSnapshot` / `saveSnapshot` / `hasSave` |
| `server/src/game/new-game.ts` | `createInitialSnapshot()` |
| `server/src/game/runtime.ts` (+test) | `loadAndCatchUp` |
| `server/src/game/projection.ts` (+test) | `projectState` read-model |
| `server/src/game/routes.ts` (+test) | `POST /api/game/new`, `GET /api/game/state` |
| `server/src/app.ts` | Register game routes |
| `SPEC.md` | Appendix C expand + §15.6 annotation |

---

## Task 1: Cross-workspace import wiring (server runs via tsx)

**Route:** opus implementer (judgment: build-model change; must keep slice-1 green). Authority to adjust tsconfig/scripts as needed, preserving: all slice-1 tests pass, the server still starts and serves `/health` + auth routes.

**Why:** `server/tsconfig.json` has `rootDir: "src"` + `composite`, which forbids importing `../../src/*` (TS6059) and emitting it. Rather than fight emit, run the server with `tsx` (on-the-fly TS, resolves cross-tree imports — exactly how `scripts/profile-economy.ts` imports `../src/*.js` in Node). Typecheck with `tsc --noEmit`.

**Files:** `server/tsconfig.json`, `server/package.json`, `server/deploy/robot-islands-auth.service`, `server/src/game/_probe.ts` (temporary).

- [ ] **Step 1: Switch server tsconfig to no-emit typecheck**

In `server/tsconfig.json`: remove `"composite": true` and `"declaration": true` and `"outDir"`/`"rootDir"`; add `"noEmit": true`. Keep `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `module`/`moduleResolution` `NodeNext`, `esModuleInterop`, `skipLibCheck`. Change `"include"` to `["src", "../src"]` so cross-tree imports typecheck.

- [ ] **Step 2: Switch server scripts to tsx**

In `server/package.json` `scripts`: `"build": "tsc --noEmit"`, `"start": "tsx src/index.ts"`, `"dev": "tsx watch src/index.ts"`, keep `"test": "DATABASE_URL=postgresql:///robot_islands_test vitest run"`, `"migrate": "tsx src/migrate.ts"`. Ensure `tsx` is a devDependency (it is).

- [ ] **Step 3: Prove a cross-tree import compiles + runs**

Create `server/src/game/_probe.ts`:
```typescript
import { SCHEMA_VERSION } from '../../../src/persistence.js';
export const probeSchemaVersion = (): number => SCHEMA_VERSION;
```

- [ ] **Step 4: Verify typecheck + slice-1 tests still green**

Run: `npm run build -w server` → clean (`tsc --noEmit` resolves the cross-tree import).
Run: `npm test -w server` → still 32 passing.
Expected: both pass.

- [ ] **Step 5: Update the systemd unit to tsx runtime**

In `server/deploy/robot-islands-auth.service`, change `ExecStart` to:
`ExecStart=/root/.nvm/versions/node/v22.22.0/bin/node --import tsx /root/robot-islands/server/src/index.ts`
(keep the `Environment=PATH=...` and `PGUSER=root` lines). Update `server/deploy/README.md`: build step is `npm run build -w server` (typecheck) and the unit runs via tsx (no `dist/`).

- [ ] **Step 6: Remove the probe + commit**

Delete `server/src/game/_probe.ts`.
```bash
git add server/tsconfig.json server/package.json server/deploy/robot-islands-auth.service server/deploy/README.md
git rm -f server/src/game/_probe.ts 2>/dev/null || true
git commit -m "build(server): tsx runtime so server imports the pure src/ layer cross-workspace"
```

- [ ] **Step 7: Re-deploy the unit (lead/manual, noted)**

After merge the lead runs: `cp server/deploy/robot-islands-auth.service /etc/systemd/system/ && systemctl daemon-reload && systemctl restart robot-islands-auth`, then `curl --connect-timeout 5 --max-time 10 -s 127.0.0.1:5180/health` → `{"ok":true}`. (Implementer need not restart systemd; just leave the unit correct.)

---

## Task 2: Extract `createNewGame` (pure) + rewire main.ts

**Route:** opus implementer (touches `main.ts`, the large render entry — needs care + deviate authority to keep behavior identical). Acceptance: `npm run build` (client) clean, root `npm test` green, no behavior change.

**Files:** Create `src/new-game.ts`, `src/new-game.test.ts`; Modify `src/main.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/new-game.test.ts
import { describe, it, expect } from 'vitest';
import { createNewGame } from './new-game.js';

describe('createNewGame', () => {
  it('builds a world with a home island state', () => {
    const { world, islandStates } = createNewGame(1000);
    expect(world.islands.find((s) => s.id === 'home')).toBeDefined();
    expect(islandStates.get('home')).toBeDefined();
  });

  it('creates state for every populated island and none for unpopulated', () => {
    const { world, islandStates } = createNewGame(1000);
    for (const spec of world.islands) {
      if (spec.populated) expect(islandStates.get(spec.id), spec.id).toBeDefined();
      else expect(islandStates.get(spec.id), spec.id).toBeUndefined();
    }
  });

  it('wires world.islandStates to the returned map', () => {
    const { world, islandStates } = createNewGame(1000);
    expect(world.islandStates).toBe(islandStates);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/new-game.test.ts`
Expected: FAIL — cannot find `./new-game.js`.

- [ ] **Step 3: Implement the pure module** (verbatim logic lifted from `main.ts:173,950-973`)

```typescript
// src/new-game.ts
import type { IslandState } from './economy.js';
import { makeInitialIslandState, makeInitialWorld, type WorldState } from './world.js';

/**
 * Build a fresh game (world + per-island state) — the pure new-game path.
 * Extracted from main.ts so the client and the authoritative server construct
 * an initial game identically. §3.7 starter contract: home + new colonies
 * start with EMPTY inventory (makeInitialIslandState provides that).
 */
export function createNewGame(
  nowMs: number,
): { world: WorldState; islandStates: Map<string, IslandState> } {
  const world = makeInitialWorld(nowMs);
  const homeSpec = world.islands.find((s) => s.id === 'home');
  if (!homeSpec) throw new Error('createNewGame: home island missing from world');
  const islandStates = new Map<string, IslandState>();
  islandStates.set('home', makeInitialIslandState(homeSpec, nowMs));
  for (const spec of world.islands) {
    if (spec.id === 'home') continue;
    if (!spec.populated) continue;
    islandStates.set(spec.id, makeInitialIslandState(spec, nowMs));
  }
  world.islandStates = islandStates;
  return { world, islandStates };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/new-game.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Rewire `main.ts` to use it (behavior-preserving)**

In `src/main.ts`:
- Add import: `import { createNewGame } from './new-game.js';`
- The fresh-game branch currently does `makeInitialWorld(performance.now())` (`:173`) and the inline `islandStates` build (`:947-966`). Replace so that when `restored` is null, both `worldState` and `islandStates` come from `createNewGame(performance.now())`. Concretely: compute `const fresh = restored ? null : createNewGame(performance.now());` then `const worldState = restored ? restored.world : fresh!.world;` and `const islandStates = restored ? restored.islandStates : fresh!.islandStates;` — and delete the now-redundant inline home/populated loop (`:955-966`), keeping the post-init sanity gate (`:970-972`) and `worldState.islandStates = islandStates` (`:973`).
- If `makeInitialWorld`/`makeInitialIslandState` imports become unused in `main.ts`, remove them (noUnusedLocals). Keep all rendering and the map-picker logic unchanged.

- [ ] **Step 6: Verify client build + full suite**

Run: `npm run build` → clean. Run: `npm test` → green (no behavior change; existing persistence/economy/boot tests pass).
Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add src/new-game.ts src/new-game.test.ts src/main.ts
git commit -m "refactor(new-game): extract createNewGame pure module; main.ts reuses it"
```

---

## Task 3: `saves` migration

**Route:** kimi. **Files:** Create `server/migrations/0002_saves.sql`.

- [ ] **Step 1: Create the migration**

```sql
-- server/migrations/0002_saves.sql
CREATE TABLE IF NOT EXISTS saves (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  snapshot       jsonb NOT NULL,
  schema_version integer NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Verify it applies (the test globalSetup runs migrations)**

Run: `npm test -w server` → still green (globalSetup applies 0001+0002 to the test DB; no new failures).

- [ ] **Step 3: Commit**

```bash
git add server/migrations/0002_saves.sql
git commit -m "feat(server): saves table migration (one snapshot per account)"
```

---

## Task 4: Game persistence repo

**Route:** kimi. **Files:** Create `server/src/game/persistence.ts`, `server/src/game/persistence.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/game/persistence.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot, hasSave } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'g@x.com', 'h')).id; }

describe('game persistence', () => {
  it('hasSave is false before, true after', async () => {
    const uid = await aUser();
    expect(await hasSave(pool, uid)).toBe(false);
    const { world, islandStates } = createNewGame(1000);
    await saveSnapshot(pool, uid, serializeWorld(world, islandStates, 1000, 1000));
    expect(await hasSave(pool, uid)).toBe(true);
  });

  it('roundtrips a snapshot identically', async () => {
    const uid = await aUser();
    const { world, islandStates } = createNewGame(1000);
    const snap = serializeWorld(world, islandStates, 1000, 1000);
    await saveSnapshot(pool, uid, snap);
    const loaded = await loadSnapshot(pool, uid);
    expect(loaded).toEqual(snap);
  });

  it('saveSnapshot upserts (second save overwrites)', async () => {
    const uid = await aUser();
    const a = serializeWorld(...Object.values(createNewGame(1000)) as [any, any], 1000, 1000);
    const b = serializeWorld(...Object.values(createNewGame(2000)) as [any, any], 2000, 2000);
    await saveSnapshot(pool, uid, a);
    await saveSnapshot(pool, uid, b);
    const loaded = await loadSnapshot(pool, uid);
    expect(loaded?.savedAt).toBe(2000);
  });

  it('loadSnapshot returns null when none', async () => {
    const uid = await aUser();
    expect(await loadSnapshot(pool, uid)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- game/persistence`
Expected: FAIL — cannot find `./persistence.js`.

- [ ] **Step 3: Implement**

```typescript
// server/src/game/persistence.ts
import type { Pool } from '../db.js';
import type { SaveSnapshot } from '../../../src/persistence.js';

export async function hasSave(pool: Pool, userId: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM saves WHERE user_id = $1', [userId]);
  return (res.rowCount ?? 0) > 0;
}

export async function loadSnapshot(pool: Pool, userId: string): Promise<SaveSnapshot | null> {
  const res = await pool.query<{ snapshot: SaveSnapshot }>(
    'SELECT snapshot FROM saves WHERE user_id = $1',
    [userId],
  );
  return res.rows[0]?.snapshot ?? null;
}

export async function saveSnapshot(pool: Pool, userId: string, snapshot: SaveSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO saves (user_id, snapshot, schema_version, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           schema_version = EXCLUDED.schema_version,
           updated_at = now()`,
    [userId, snapshot, snapshot.v],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- game/persistence`
Expected: PASS (4 assertions). (`pg` serializes a JS object bound to a `jsonb` param and parses `jsonb` back to an object, so the roundtrip is structural.)

- [ ] **Step 5: Commit**

```bash
git add server/src/game/persistence.ts server/src/game/persistence.test.ts
git commit -m "feat(server): game persistence repo (load/save/has snapshot in Postgres)"
```

---

## Task 5: New-game snapshot builder

**Route:** kimi. **Files:** Create `server/src/game/new-game.ts`.

- [ ] **Step 1: Implement** (covered by the runtime/routes tests; no standalone test needed)

```typescript
// server/src/game/new-game.ts
import { serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import { createNewGame } from '../../../src/new-game.js';

/** Build the initial SaveSnapshot for a brand-new account. Stamp wall == perf
 *  so offline catch-up on first load integrates from `now`. */
export function createInitialSnapshot(now: number): SaveSnapshot {
  const { world, islandStates } = createNewGame(now);
  return serializeWorld(world, islandStates, now, now);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run build -w server` → clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/game/new-game.ts
git commit -m "feat(server): createInitialSnapshot for new accounts"
```

---

## Task 6: Runtime — load + offline catch-up + persist

**Route:** kimi. **Files:** Create `server/src/game/runtime.ts`, `server/src/game/runtime.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/game/runtime.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from '../auth/users.js';
import { saveSnapshot, loadSnapshot } from './persistence.js';
import { loadAndCatchUp } from './runtime.js';
import { createInitialSnapshot } from './new-game.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'r@x.com', 'h')).id; }

describe('runtime loadAndCatchUp', () => {
  it('returns deserialized state and persists an advanced snapshot', async () => {
    const uid = await aUser();
    // Save a snapshot stamped ~2 hours ago so there is an offline gap.
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const snap = createInitialSnapshot(twoHoursAgo);
    await saveSnapshot(pool, uid, snap);

    const result = await loadAndCatchUp(pool, uid, Date.now());
    expect(result).not.toBeNull();
    expect(result!.islandStates.get('home')).toBeDefined();

    // Persisted snapshot's savedAt advanced to ~now (catch-up was saved).
    const after = await loadSnapshot(pool, uid);
    expect(after!.savedAt).toBeGreaterThan(snap.savedAt);
  });

  it('returns null when the account has no save', async () => {
    const uid = await aUser();
    expect(await loadAndCatchUp(pool, uid, Date.now())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- game/runtime`
Expected: FAIL — cannot find `./runtime.js`.

- [ ] **Step 3: Implement**

```typescript
// server/src/game/runtime.ts
import type { Pool } from '../db.js';
import type { IslandState } from '../../../src/economy.js';
import { advanceIsland } from '../../../src/economy.js';
import { deserializeWorld, serializeWorld, type SaveSnapshot } from '../../../src/persistence.js';
import type { WorldState } from '../../../src/world.js';
import { loadSnapshot, saveSnapshot } from './persistence.js';

export interface LiveGame { world: WorldState; islandStates: Map<string, IslandState>; }

/**
 * Load an account's save, integrate the offline gap to `now`, persist the
 * advanced state, and return it. `now` is used as BOTH wall and perf clock so
 * deserializeWorld's perfShift collapses to the real elapsed time since the
 * last save (which was stamped wall == perf). Same path for a 1s and a 30d gap.
 */
export async function loadAndCatchUp(pool: Pool, userId: string, now: number): Promise<LiveGame | null> {
  const snapshot = await loadSnapshot(pool, userId);
  if (snapshot === null) return null;
  const { world, islandStates } = deserializeWorld(snapshot, now, now);
  for (const spec of world.islands) {
    if (!spec.populated) continue;
    const state = islandStates.get(spec.id);
    if (state) advanceIsland(state, now);
  }
  const advanced: SaveSnapshot = serializeWorld(world, islandStates, now, now);
  await saveSnapshot(pool, userId, advanced);
  return { world, islandStates };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- game/runtime`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/game/runtime.ts server/src/game/runtime.test.ts
git commit -m "feat(server): runtime loadAndCatchUp (offline integrate + persist)"
```

---

## Task 7: Projection read-model

**Route:** kimi. **Files:** Create `server/src/game/projection.ts`, `server/src/game/projection.test.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/game/projection.test.ts
import { describe, it, expect } from 'vitest';
import { createNewGame } from '../../../src/new-game.js';
import { projectGame } from './projection.js';

describe('projectGame', () => {
  it('summarizes every populated island', () => {
    const { world, islandStates } = createNewGame(1000);
    const proj = projectGame({ world, islandStates });
    expect(proj.islands.length).toBe(islandStates.size);
    const home = proj.islands.find((i) => i.id === 'home');
    expect(home).toBeDefined();
    expect(typeof home!.level).toBe('number');
    expect(typeof home!.xp).toBe('number');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- game/projection`
Expected: FAIL — cannot find `./projection.js`.

- [ ] **Step 3: Implement** (minimal read-model; full projection is slice 3)

```typescript
// server/src/game/projection.ts
import type { LiveGame } from './runtime.js';

export interface IslandProjection {
  readonly id: string;
  readonly level: number;
  readonly xp: number;
  readonly inventory: Readonly<Record<string, number>>;
}
export interface GameProjection { readonly islands: ReadonlyArray<IslandProjection>; }

export function projectGame(game: LiveGame): GameProjection {
  const islands: IslandProjection[] = [];
  for (const [id, state] of game.islandStates) {
    islands.push({ id, level: state.level, xp: state.xp, inventory: { ...state.inventory } });
  }
  return { islands };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- game/projection`
Expected: PASS. (If `IslandState` field names differ, the implementer reads `src/economy.ts`'s `IslandState` and maps the real fields — `level`, `xp`, `inventory` are confirmed present in the deserializer's `live` shape.)

- [ ] **Step 5: Commit**

```bash
git add server/src/game/projection.ts server/src/game/projection.test.ts
git commit -m "feat(server): minimal game projection read-model"
```

---

## Task 8: Game routes + registration

**Route:** kimi. **Files:** Create `server/src/game/routes.ts`, `server/src/game/routes.test.ts`; Modify `server/src/app.ts`.

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/game/routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';

const pool = testPool();
const app = buildTestApp(pool);
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

const CREDS = { email: 'gamer@x.com', password: 'a-strong-password' };
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0]!;
}
async function authedCookie(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: CREDS });
  return cookieFrom(r);
}

describe('game routes', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/game/state' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/game/new' })).statusCode).toBe(401);
  });

  it('new -> 201, duplicate -> 409', async () => {
    const cookie = await authedCookie();
    expect((await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } })).statusCode).toBe(409);
  });

  it('state -> 404 before new, projection after', async () => {
    const cookie = await authedCookie();
    expect((await app.inject({ method: 'GET', url: '/api/game/state', headers: { cookie } })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/api/game/state', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().islands.find((i: { id: string }) => i.id === 'home')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- game/routes`
Expected: FAIL — `/api/game/*` not registered.

- [ ] **Step 3: Implement the routes plugin**

```typescript
// server/src/game/routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { makeAuthGuard } from '../auth/guard.js';
import { hasSave, saveSnapshot } from './persistence.js';
import { createInitialSnapshot } from './new-game.js';
import { loadAndCatchUp } from './runtime.js';
import { projectGame } from './projection.js';

export function registerGameRoutes(app: FastifyInstance, pool: Pool): void {
  const guard = makeAuthGuard(pool);

  app.post('/api/game/new', { preHandler: guard }, async (req, reply) => {
    const userId = req.user!.id;
    if (await hasSave(pool, userId)) return reply.code(409).send({ error: 'game already exists' });
    const now = Date.now();
    await saveSnapshot(pool, userId, createInitialSnapshot(now));
    const game = await loadAndCatchUp(pool, userId, now);
    return reply.code(201).send(projectGame(game!));
  });

  app.get('/api/game/state', { preHandler: guard }, async (req, reply) => {
    const game = await loadAndCatchUp(pool, req.user!.id, Date.now());
    if (game === null) return reply.code(404).send({ error: 'no game' });
    return reply.code(200).send(projectGame(game));
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

In `server/src/app.ts`, import `registerGameRoutes` and call `registerGameRoutes(app, opts.pool);` after the auth plugin registration (outside the tighter auth rate-limit plugin scope, so game routes use the global 100/min limiter). Do not change auth wiring.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- game/routes`
Expected: PASS (3 assertions).

- [ ] **Step 6: Full build + suite**

Run: `npm run build -w server && npm test -w server`
Expected: clean; all server suites green (auth + game).

- [ ] **Step 7: Commit**

```bash
git add server/src/game/routes.ts server/src/game/routes.test.ts server/src/app.ts
git commit -m "feat(server): game routes (new/state) + registration"
```

---

## Task 9: SPEC.md — Appendix C expand + §15.6 annotation

**Route:** kimi (or haiku). **Files:** Modify `SPEC.md`.

- [ ] **Step 1: Expand Appendix C**

Replace the Appendix C stub body (added in slice 1) so it additionally describes: the per-account server runtime (`loadAndCatchUp`), the `saves` table (one snapshot per account), reuse of `serializeWorld`/`deserializeWorld`/`advanceIsland` unchanged, the `Date.now()`-for-both-clocks offline catch-up model, and that the server runs the pure layer via `tsx`. Reference the slice-2 design doc path.

- [ ] **Step 2: Annotate §15.6**

Add a sentence at §15.6 marking it **superseded for state ownership** by the server migration (state + persistence become server-authoritative for server accounts; the browser client still runs locally until the slice-4 cutover), pointing to Appendix C. Do not delete §15.6.

- [ ] **Step 3: Verify + commit**

Run: `npm test` (root) → still green (SPEC.md is docs; no code impact).
```bash
git add SPEC.md
git commit -m "docs(spec): SPEC.md Appendix C runtime+persistence; §15.6 superseded-for-state note"
```

---

## Self-Review (plan author)

**Spec coverage:** saves table → T3; persistence repo → T4; new-game (pure + snapshot) → T2,T5; runtime/catch-up → T6; projection → T7; HTTP surface → T8; cross-tree import enablement (implicit spec requirement "reuse pure src/") → T1; SPEC handling → T9; testing per module → each task; time model → T6. The dropped §5 extraction is intentionally absent (deserializeWorld auto-migrates).

**Type consistency:** `Pool` (slice 1 `db.ts`) throughout; `SaveSnapshot`/`serializeWorld`/`deserializeWorld` from `src/persistence.ts`; `createNewGame` returns `{world, islandStates}` consumed by `createInitialSnapshot` (T5) and tests; `LiveGame{world,islandStates}` (T6) consumed by `projectGame` (T7); `req.user` from slice-1 `guard.ts` augmentation; `buildTestApp` (slice 1) used by T8 tests; routes use `hasSave`/`saveSnapshot`/`createInitialSnapshot`/`loadAndCatchUp`/`projectGame` exactly as defined.

**Cross-tree import note:** every server `game/*` import of the client layer uses the `../../../src/<mod>.js` specifier (from `server/src/game/`), enabled by T1 (tsx runtime + `tsc --noEmit` include of `../src`). `IslandState` field names (`level`, `xp`, `inventory`) are confirmed from the deserializer's `live` shape; if any differ at implementation time, the implementer reads `src/economy.ts` and maps the real fields (do not invent).

**Routing:** T1, T2 → opus (build-model + main.ts judgment). T3–T9 → kimi (mechanical, verbatim). Reviewers (spec + quality) → opus per task or batched after T8/T9.
