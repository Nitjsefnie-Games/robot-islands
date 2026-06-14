# Server Migration Slice 1 — Auth Service + User Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a standalone Node + Fastify server providing email+password accounts with revocable server-side sessions, backed by the box's existing PostgreSQL, with zero changes to the Vite client.

**Architecture:** New `server/` npm workspace. Pure dep-free crypto (scrypt password hashing, opaque session tokens) → Postgres repos (users, sessions) → Fastify HTTP routes (`/api/auth/{signup,login,logout,me}`). Server-side `sessions` table is the single source of truth (only `sha256(token)` stored), enabling instant revoke/ban. Migrations run on boot.

**Tech Stack:** TypeScript (strict), Fastify, `@fastify/cookie`, `@fastify/rate-limit`, `pg` (node-postgres), `node:crypto` (scrypt + sha256 + randomBytes), vitest. PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-06-13-server-auth-slice-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` (root) | Add `"workspaces": ["server"]` |
| `server/package.json` | Server package deps + scripts |
| `server/tsconfig.json` | Strict TS config for the server |
| `server/.gitignore` | Ignore `.env`, `dist/` |
| `server/.env.example` | Documented env template |
| `server/vitest.config.ts` | vitest config + globalSetup (migrate test DB) |
| `server/migrations/0001_init.sql` | Extensions + `schema_migrations`, `users`, `sessions` |
| `server/src/config.ts` | Parse/validate env into a `Config`; test-DB guard |
| `server/src/db.ts` | Build a `pg.Pool` from a `DATABASE_URL` |
| `server/src/migrate.ts` | Apply pending numbered SQL migrations in a transaction |
| `server/src/crypto/password.ts` | scrypt hash/verify (pure) |
| `server/src/crypto/token.ts` | Opaque token generation + sha256 hashing (pure) |
| `server/src/auth/users.ts` | User repo: create / findByEmail / findById |
| `server/src/auth/sessions.ts` | Session repo: create / findValid / revoke |
| `server/src/auth/cookie.ts` | Session cookie set/clear helpers + name constant |
| `server/src/auth/guard.ts` | Fastify preHandler resolving cookie → `request.user` |
| `server/src/auth/routes.ts` | Auth route plugin (signup/login/logout/me) |
| `server/src/app.ts` | `buildApp(config)` Fastify factory (no listen) |
| `server/src/index.ts` | Entry point: load config, migrate, build app, listen |
| `server/src/test-helpers.ts` | `testPool()`, `resetDb()`, `buildTestApp()` |
| `server/deploy/robot-islands-server.service` | systemd unit |
| `SPEC.md` | Append "Appendix C — Server architecture (migration)" stub |

Test files are colocated: `password.test.ts`, `token.test.ts`, `migrate.test.ts`, `users.test.ts`, `sessions.test.ts`, `routes.test.ts`.

---

## Prerequisites (one-time, manual — do before Task 4 tests)

Create the prod + test databases as the box's postgres root role and enable extensions are handled by the migration. Run:

```bash
su postgres -c 'createdb -O robot_islands robot_islands'      || true
su postgres -c 'createdb -O robot_islands robot_islands_test' || true
```

Note: services connect via socket peer as the OS root user (`postgresql:///robot_islands`). If peer-as-root lacks rights, grant: `su postgres -c "psql -c 'GRANT ALL ON DATABASE robot_islands TO root; GRANT ALL ON DATABASE robot_islands_test TO root;'"`. Migration 0001 runs `CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;` which requires superuser or the extension to be pre-created; the box's `root` PG role is the connecting identity — if it is not superuser, pre-create the extensions once: `su postgres -c "psql -d robot_islands -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;'"` and likewise for `robot_islands_test`.

---

## Task 1: Workspace scaffold

**Files:**
- Modify: `package.json` (root)
- Create: `server/package.json`, `server/tsconfig.json`, `server/.gitignore`, `server/.env.example`

- [ ] **Step 1: Add the workspace to root `package.json`**

Add the `workspaces` key (place after `"private": true`). The rest of root `package.json` is unchanged.

```json
  "workspaces": ["server"],
```

- [ ] **Step 2: Create `server/package.json`**

```json
{
  "name": "@robot-islands/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "migrate": "tsx src/migrate.ts"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/rate-limit": "^10.2.2",
    "fastify": "^5.2.1",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^25.7.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.22.3",
    "typescript": "^5.6.0",
    "vitest": "^4.1.5"
  }
}
```

- [ ] **Step 3: Create `server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true
  },
  "include": ["src"],
  "exclude": ["dist", "**/*.test.ts"]
}
```

- [ ] **Step 4: Create `server/.gitignore`**

```
node_modules/
dist/
.env
*.tsbuildinfo
```

- [ ] **Step 5: Create `server/.env.example`**

```
# Postgres connection. Socket-peer-as-root convention (no password).
DATABASE_URL=postgresql:///robot_islands
# HTTP listen port (localhost only; nginx proxies later).
PORT=5180
# 1 = set the Secure flag on the session cookie (production). 0 in plain-HTTP dev.
COOKIE_SECURE=1
```

- [ ] **Step 6: Install deps**

Run: `npm install`
Expected: workspaces resolve; `server/node_modules` (or hoisted root) populated; no errors.

- [ ] **Step 7: Verify the client still builds (regression guard)**

Run: `npm run build`
Expected: the existing Vite client build succeeds unchanged.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json server/package.json server/tsconfig.json server/.gitignore server/.env.example
git commit -m "feat(server): scaffold server workspace (Fastify+pg) — slice 1 auth"
```

---

## Task 2: Config parsing

**Files:**
- Create: `server/src/config.ts`
- Test: `server/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/config.test.ts
import { describe, it, expect } from 'vitest';
import { loadConfig, assertTestDatabase } from './config.js';

describe('loadConfig', () => {
  it('parses a full env', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql:///robot_islands', PORT: '5180', COOKIE_SECURE: '1' });
    expect(c.databaseUrl).toBe('postgresql:///robot_islands');
    expect(c.port).toBe(5180);
    expect(c.cookieSecure).toBe(true);
  });

  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql:///robot_islands' });
    expect(c.port).toBe(5180);
    expect(c.cookieSecure).toBe(true);
  });

  it('throws when DATABASE_URL missing', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('cookieSecure=false when COOKIE_SECURE=0', () => {
    expect(loadConfig({ DATABASE_URL: 'x', COOKIE_SECURE: '0' }).cookieSecure).toBe(false);
  });
});

describe('assertTestDatabase', () => {
  it('passes for a _test db', () => {
    expect(() => assertTestDatabase('postgresql:///robot_islands_test')).not.toThrow();
  });
  it('throws for a non-_test db', () => {
    expect(() => assertTestDatabase('postgresql:///robot_islands')).toThrow(/_test/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- config`
Expected: FAIL — cannot find module `./config.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/config.ts
export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly cookieSecure: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = env.PORT ? Number(env.PORT) : 5180;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT: ${env.PORT}`);
  const cookieSecure = env.COOKIE_SECURE !== '0';
  return { databaseUrl, port, cookieSecure };
}

/** Guard: refuse to run destructive test setup against a non-test database. */
export function assertTestDatabase(databaseUrl: string): void {
  // Match the database name (last path segment, before any query string).
  const name = databaseUrl.split('/').pop()?.split('?')[0] ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to use non-test database "${name}" (must end in _test)`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- config`
Expected: PASS (all 6 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/config.test.ts
git commit -m "feat(server): config env parsing + test-db guard"
```

---

## Task 3: Password hashing (scrypt)

**Files:**
- Create: `server/src/crypto/password.ts`
- Test: `server/src/crypto/password.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/crypto/password.test.ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password', () => {
  it('hash is PHC-formatted and not the plaintext', () => {
    const h = hashPassword('correct horse battery staple');
    expect(h).not.toContain('correct horse');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(h.split('$')).toHaveLength(4); // scrypt$params$salt$hash
  });

  it('verify roundtrips', () => {
    const h = hashPassword('hunter2hunter2');
    expect(verifyPassword(h, 'hunter2hunter2')).toBe(true);
  });

  it('verify rejects wrong password', () => {
    const h = hashPassword('hunter2hunter2');
    expect(verifyPassword(h, 'wrongpassword')).toBe(false);
  });

  it('two hashes of the same password differ (random salt)', () => {
    expect(hashPassword('samepasswordhere')).not.toBe(hashPassword('samepasswordhere'));
  });

  it('verify returns false on malformed stored hash', () => {
    expect(verifyPassword('not-a-valid-hash', 'whatever')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- password`
Expected: FAIL — cannot find module `./password.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/crypto/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 32768; // 2**15
const r = 8;
const p = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024; // 128*N*r ~= 33.5MB; give headroom

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: MAXMEM });
  return `scrypt$N=${N},r=${r},p=${p}$${b64url(salt)}$${b64url(hash)}`;
}

export function verifyPassword(stored: string, password: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params = parts[1]!;
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!m) return false;
  const pn = Number(m[1]), pr = Number(m[2]), pp = Number(m[3]);
  let salt: Buffer, expected: Buffer;
  try {
    salt = Buffer.from(parts[2]!, 'base64url');
    expected = Buffer.from(parts[3]!, 'base64url');
  } catch {
    return false;
  }
  let candidate: Buffer;
  try {
    candidate = scryptSync(password, salt, expected.length, { N: pn, r: pr, p: pp, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- password`
Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/crypto/password.ts server/src/crypto/password.test.ts
git commit -m "feat(server): scrypt password hash/verify (PHC-encoded)"
```

---

## Task 4: Session tokens

**Files:**
- Create: `server/src/crypto/token.ts`
- Test: `server/src/crypto/token.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/crypto/token.test.ts
import { describe, it, expect } from 'vitest';
import { generateToken, hashToken } from './token.js';

describe('token', () => {
  it('generates url-safe tokens of stable length', () => {
    const t = generateToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t.length).toBeGreaterThanOrEqual(40);
  });

  it('generates unique tokens', () => {
    const set = new Set(Array.from({ length: 100 }, () => generateToken()));
    expect(set.size).toBe(100);
  });

  it('hashToken is deterministic and 32 bytes', () => {
    const t = generateToken();
    const h1 = hashToken(t);
    const h2 = hashToken(t);
    expect(h1.equals(h2)).toBe(true);
    expect(h1.length).toBe(32);
  });

  it('hash differs from the raw token', () => {
    const t = generateToken();
    expect(hashToken(t).toString('base64url')).not.toBe(t);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- token`
Expected: FAIL — cannot find module `./token.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/crypto/token.ts
import { createHash, randomBytes } from 'node:crypto';

/** Raw opaque session token — goes in the cookie, never stored. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256 of the raw token — this is what the sessions table stores. */
export function hashToken(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- token`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/crypto/token.ts server/src/crypto/token.test.ts
git commit -m "feat(server): opaque session token gen + sha256 hashing"
```

---

## Task 5: Database pool + migration SQL

**Files:**
- Create: `server/src/db.ts`
- Create: `server/migrations/0001_init.sql`

- [ ] **Step 1: Create the pool module**

```typescript
// server/src/db.ts
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
```

- [ ] **Step 2: Create migration 0001**

```sql
-- server/migrations/0001_init.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext UNIQUE NOT NULL,
  password   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
```

- [ ] **Step 3: Typecheck**

Run: `npm run build -w server`
Expected: compiles clean (db.ts only; no entry point yet — `tsc -b` succeeds).

- [ ] **Step 4: Commit**

```bash
git add server/src/db.ts server/migrations/0001_init.sql
git commit -m "feat(server): pg pool factory + initial schema migration"
```

---

## Task 6: Migration runner

**Files:**
- Create: `server/src/migrate.ts`
- Test: `server/src/migrate.test.ts`

- [ ] **Step 1: Write the failing test** (runs against `robot_islands_test`)

```typescript
// server/src/migrate.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';
const pool = createPool(URL);

beforeAll(async () => {
  await pool.query('DROP TABLE IF EXISTS sessions, users, schema_migrations CASCADE');
});
afterAll(async () => { await pool.end(); });

describe('runMigrations', () => {
  it('creates schema_migrations and applies 0001', async () => {
    await runMigrations(pool);
    const v = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(v.rows.map((r) => r.version)).toContain(1);
    const t = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('users','sessions')",
    );
    expect(t.rows.length).toBe(2);
  });

  it('is idempotent (second run is a no-op)', async () => {
    await runMigrations(pool);
    const v = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(v.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql:///robot_islands_test npm test -w server -- migrate`
Expected: FAIL — cannot find module `./migrate.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/migrate.ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Migration { readonly version: number; readonly name: string; readonly sql: string; }

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = /^(\d+)_/.exec(f);
      if (!m) throw new Error(`migration file lacks numeric prefix: ${f}`);
      return { version: Number(m[1]), name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations')).rows.map((row) => Number(row.version)),
  );
  for (const mig of loadMigrations()) {
    if (applied.has(mig.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(mig.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [mig.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${mig.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
}

// Allow `tsx src/migrate.ts` standalone use.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPool } = await import('./db.js');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url);
  await runMigrations(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('migrations applied');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql:///robot_islands_test npm test -w server -- migrate`
Expected: PASS (2 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/migrate.ts server/src/migrate.test.ts
git commit -m "feat(server): transactional numbered-SQL migration runner"
```

---

## Task 7: Test harness (vitest globalSetup + helpers)

**Files:**
- Create: `server/vitest.config.ts`
- Create: `server/src/test-helpers.ts`
- Create: `server/src/test-setup.ts` (globalSetup)
- Modify: `server/package.json` (test script sets the test DATABASE_URL)

- [ ] **Step 1: Point the test script at the test DB**

Edit `server/package.json` `scripts.test`:

```json
    "test": "DATABASE_URL=postgresql:///robot_islands_test vitest run",
```

- [ ] **Step 2: Create the globalSetup that migrates the test DB once**

```typescript
// server/src/test-setup.ts
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { assertTestDatabase } from './config.js';

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';
  assertTestDatabase(url);
  const pool = createPool(url);
  await runMigrations(pool);
  await pool.end();
}
```

- [ ] **Step 3: Create the vitest config**

```typescript
// server/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-setup.ts'],
    fileParallelism: false, // shared DB; avoid cross-file truncation races
  },
});
```

- [ ] **Step 4: Create per-test helpers**

```typescript
// server/src/test-helpers.ts
import { createPool, type Pool } from './db.js';
import { assertTestDatabase } from './config.js';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';

export function testPool(): Pool {
  assertTestDatabase(URL);
  return createPool(URL);
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE sessions, users RESTART IDENTITY CASCADE');
}

export function buildTestApp(pool: Pool): FastifyInstance {
  return buildApp({ pool, cookieSecure: false });
}
```

- [ ] **Step 5: Note — `buildApp` and `app.ts` are created in Task 11.**

This task's files reference `./app.js`; they will not typecheck until Task 11 lands. That is expected — `test-helpers.ts` is only imported by the repo/route tests in Tasks 8–11. Do not run `npm run build -w server` to verify this task; verify by file creation only.

- [ ] **Step 6: Commit**

```bash
git add server/vitest.config.ts server/src/test-setup.ts server/src/test-helpers.ts server/package.json
git commit -m "test(server): vitest globalSetup migrates test DB + per-test helpers"
```

---

## Task 8: Users repo

**Files:**
- Create: `server/src/auth/users.ts`
- Test: `server/src/auth/users.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/auth/users.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser, findByEmail, findById, EmailTakenError } from './users.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

describe('users repo', () => {
  it('creates and finds by id', async () => {
    const u = await createUser(pool, 'A@Example.com', 'hash1');
    expect(u.email).toBe('A@Example.com');
    const found = await findById(pool, u.id);
    expect(found?.email).toBe('A@Example.com');
  });

  it('findByEmail is case-insensitive and returns the password', async () => {
    await createUser(pool, 'mixed@Case.com', 'hash2');
    const row = await findByEmail(pool, 'MIXED@case.COM');
    expect(row?.password).toBe('hash2');
  });

  it('rejects duplicate email with EmailTakenError', async () => {
    await createUser(pool, 'dup@x.com', 'h');
    await expect(createUser(pool, 'DUP@x.com', 'h2')).rejects.toBeInstanceOf(EmailTakenError);
  });

  it('returns null for unknown lookups', async () => {
    expect(await findByEmail(pool, 'nobody@x.com')).toBeNull();
    expect(await findById(pool, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- users`
Expected: FAIL — cannot find module `./users.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/auth/users.ts
import type { Pool } from '../db.js';

export interface PublicUser { readonly id: string; readonly email: string; }
export interface UserWithSecret extends PublicUser { readonly password: string; }

export class EmailTakenError extends Error {
  constructor() { super('email already registered'); this.name = 'EmailTakenError'; }
}

export async function createUser(pool: Pool, email: string, passwordHash: string): Promise<PublicUser> {
  try {
    const res = await pool.query<PublicUser>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash],
    );
    return res.rows[0]!;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new EmailTakenError();
    }
    throw err;
  }
}

export async function findByEmail(pool: Pool, email: string): Promise<UserWithSecret | null> {
  const res = await pool.query<UserWithSecret>(
    'SELECT id, email, password FROM users WHERE email = $1',
    [email],
  );
  return res.rows[0] ?? null;
}

export async function findById(pool: Pool, id: string): Promise<PublicUser | null> {
  const res = await pool.query<PublicUser>('SELECT id, email FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- users`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/users.ts server/src/auth/users.test.ts
git commit -m "feat(server): users repo (create/findByEmail/findById, EmailTakenError)"
```

---

## Task 9: Sessions repo

**Files:**
- Create: `server/src/auth/sessions.ts`
- Test: `server/src/auth/sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/auth/sessions.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from '../test-helpers.js';
import { createUser } from './users.js';
import { createSession, findValidSession, revokeSession } from './sessions.js';
import { hashToken } from '../crypto/token.js';

const pool = testPool();
beforeEach(() => resetDb(pool));
afterAll(() => pool.end());

async function aUser() { return (await createUser(pool, 'sess@x.com', 'h')).id; }

describe('sessions repo', () => {
  it('creates then finds a valid session (joined to user)', async () => {
    const uid = await aUser();
    const th = hashToken('tok-a');
    await createSession(pool, uid, th, new Date(Date.now() + 60_000));
    const s = await findValidSession(pool, th, new Date());
    expect(s?.userId).toBe(uid);
    expect(s?.email).toBe('sess@x.com');
  });

  it('does not find an expired session', async () => {
    const uid = await aUser();
    const th = hashToken('tok-b');
    await createSession(pool, uid, th, new Date(Date.now() - 1000));
    expect(await findValidSession(pool, th, new Date())).toBeNull();
  });

  it('revoke makes a session invalid', async () => {
    const uid = await aUser();
    const th = hashToken('tok-c');
    await createSession(pool, uid, th, new Date(Date.now() + 60_000));
    await revokeSession(pool, th, new Date());
    expect(await findValidSession(pool, th, new Date())).toBeNull();
  });

  it('only stores the hash, never a recoverable raw token', async () => {
    const uid = await aUser();
    await createSession(pool, uid, hashToken('secret-raw'), new Date(Date.now() + 60_000));
    const res = await pool.query("SELECT encode(token_hash,'escape') AS h FROM sessions");
    expect(res.rows[0].h).not.toContain('secret-raw');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- sessions`
Expected: FAIL — cannot find module `./sessions.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/src/auth/sessions.ts
import type { Pool } from '../db.js';

export interface ValidSession { readonly userId: string; readonly email: string; }

export async function createSession(
  pool: Pool, userId: string, tokenHash: Buffer, expiresAt: Date,
): Promise<void> {
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  );
}

export async function findValidSession(
  pool: Pool, tokenHash: Buffer, now: Date,
): Promise<ValidSession | null> {
  const res = await pool.query<{ userId: string; email: string }>(
    `UPDATE sessions s SET last_seen_at = $2
       FROM users u
      WHERE s.token_hash = $1
        AND s.user_id = u.id
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
     RETURNING u.id AS "userId", u.email AS email`,
    [tokenHash, now],
  );
  return res.rows[0] ?? null;
}

export async function revokeSession(pool: Pool, tokenHash: Buffer, now: Date): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash, now],
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- sessions`
Expected: PASS (4 assertions).

- [ ] **Step 5: Commit**

```bash
git add server/src/auth/sessions.ts server/src/auth/sessions.test.ts
git commit -m "feat(server): sessions repo (create/findValid/revoke; touch last_seen)"
```

---

## Task 10: Cookie helpers + auth guard

**Files:**
- Create: `server/src/auth/cookie.ts`
- Create: `server/src/auth/guard.ts`

- [ ] **Step 1: Create the cookie helpers**

```typescript
// server/src/auth/cookie.ts
import type { FastifyReply } from 'fastify';

export const SESSION_COOKIE = 'ri_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

interface CookieOpts { readonly secure: boolean; }

export function setSessionCookie(reply: FastifyReply, token: string, opts: CookieOpts): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, opts: CookieOpts): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: opts.secure, sameSite: 'lax', path: '/' });
}
```

- [ ] **Step 2: Create the guard (preHandler) + the request typing**

```typescript
// server/src/auth/guard.ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db.js';
import { hashToken } from '../crypto/token.js';
import { findValidSession } from './sessions.js';
import { SESSION_COOKIE } from './cookie.js';

declare module 'fastify' {
  interface FastifyRequest { user?: { id: string; email: string }; }
}

/** Resolve the session cookie to req.user, or 401. Use as a route preHandler. */
export function makeAuthGuard(pool: Pool) {
  return async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    const session = await findValidSession(pool, hashToken(token), new Date());
    if (!session) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    req.user = { id: session.userId, email: session.email };
  };
}
```

- [ ] **Step 3: Typecheck (no test yet — exercised via routes in Task 11)**

These files are imported by `routes.ts`/`app.ts` (Task 11); defer build verification to Task 11.

- [ ] **Step 4: Commit**

```bash
git add server/src/auth/cookie.ts server/src/auth/guard.ts
git commit -m "feat(server): session cookie helpers + auth guard preHandler"
```

---

## Task 11: Auth routes + app factory

**Files:**
- Create: `server/src/auth/routes.ts`
- Create: `server/src/app.ts`
- Test: `server/src/auth/routes.test.ts`

- [ ] **Step 1: Write the failing test** (uses `fastify.inject`, no real listen)

```typescript
// server/src/auth/routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';

const pool = testPool();
const app = buildTestApp(pool);
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

const GOOD = { email: 'player@x.com', password: 'a-strong-password' };

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const str = Array.isArray(raw) ? raw[0] : String(raw);
  return str.split(';')[0]!; // "ri_session=..."
}

describe('auth routes', () => {
  it('signup returns 201 + sets cookie + body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toBeTruthy();
    expect(res.json().email).toBe('player@x.com');
  });

  it('rejects short passwords with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@b.c', password: 'short' } });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate signup returns 409', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    expect(res.statusCode).toBe(409);
  });

  it('me returns the user when authenticated, 401 otherwise', async () => {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const cookie = cookieFrom(signup);
    const ok = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe('player@x.com');
    const no = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(no.statusCode).toBe(401);
  });

  it('login wrong password 401, correct 200', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...GOOD, password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: GOOD });
    expect(good.statusCode).toBe(200);
  });

  it('login with unknown email 401 (no oracle)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@x.com', password: 'whatever-long' } });
    expect(res.statusCode).toBe(401);
  });

  it('logout revokes: me then returns 401', async () => {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const cookie = cookieFrom(signup);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- routes`
Expected: FAIL — cannot find module `../test-helpers.js` chain → `./app.js`.

- [ ] **Step 3: Write the routes plugin**

```typescript
// server/src/auth/routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/token.js';
import { createUser, findByEmail, EmailTakenError } from './users.js';
import { createSession, revokeSession } from './sessions.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_TTL_MS } from './cookie.js';
import { makeAuthGuard } from './guard.js';

// A throwaway hash to run verify against unknown emails (defeats timing oracle).
const DUMMY_HASH = hashPassword('this-is-never-a-real-password');

const credentialsSchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', format: 'email', maxLength: 320 },
    password: { type: 'string', minLength: 12, maxLength: 200 },
  },
} as const;

interface Creds { email: string; password: string; }

export function registerAuthRoutes(app: FastifyInstance, pool: Pool, cookieSecure: boolean): void {
  const guard = makeAuthGuard(pool);
  const cookieOpts = { secure: cookieSecure };

  async function issueSession(userId: string): Promise<string> {
    const token = generateToken();
    await createSession(pool, userId, hashToken(token), new Date(Date.now() + SESSION_TTL_MS));
    return token;
  }

  app.post<{ Body: Creds }>('/api/auth/signup', { schema: { body: credentialsSchema } }, async (req, reply) => {
    try {
      const user = await createUser(pool, req.body.email, hashPassword(req.body.password));
      setSessionCookie(reply, await issueSession(user.id), cookieOpts);
      return reply.code(201).send({ id: user.id, email: user.email });
    } catch (err) {
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: 'email already registered' });
      throw err;
    }
  });

  app.post<{ Body: Creds }>('/api/auth/login', { schema: { body: credentialsSchema } }, async (req, reply) => {
    const user = await findByEmail(pool, req.body.email);
    const ok = user ? verifyPassword(user.password, req.body.password) : (verifyPassword(DUMMY_HASH, req.body.password), false);
    if (!user || !ok) return reply.code(401).send({ error: 'invalid email or password' });
    setSessionCookie(reply, await issueSession(user.id), cookieOpts);
    return reply.code(200).send({ id: user.id, email: user.email });
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(pool, hashToken(token), new Date());
    clearSessionCookie(reply, cookieOpts);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: guard }, async (req, reply) => {
    return reply.code(200).send(req.user);
  });
}
```

- [ ] **Step 4: Write the app factory**

```typescript
// server/src/app.ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from './db.js';
import { registerAuthRoutes } from './auth/routes.js';

export interface AppOptions { readonly pool: Pool; readonly cookieSecure: boolean; }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.register(async (instance) => {
    // Tighter limit on auth endpoints.
    await instance.register(rateLimit, { max: 10, timeWindow: '1 minute' });
    registerAuthRoutes(instance, opts.pool, opts.cookieSecure);
  });
  app.get('/health', async () => ({ ok: true }));
  return app;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- routes`
Expected: PASS (7 assertions). If `@fastify/rate-limit` interferes with the rapid duplicate-signup test, confirm `max:10` is not exceeded by the test counts (each test resets state but not the limiter — keep auth tests ≤10 requests per minute per route, which they are).

- [ ] **Step 6: Full build + full server test suite**

Run: `npm run build -w server && npm test -w server`
Expected: clean compile; all suites green (config, password, token, migrate, users, sessions, routes).

- [ ] **Step 7: Commit**

```bash
git add server/src/auth/routes.ts server/src/app.ts server/src/auth/routes.test.ts
git commit -m "feat(server): auth routes (signup/login/logout/me) + Fastify app factory"
```

---

## Task 12: Entry point

**Files:**
- Create: `server/src/index.ts`

- [ ] **Step 1: Create the entry point**

```typescript
// server/src/index.ts
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const app = buildApp({ pool, cookieSecure: config.cookieSecure });
  await app.listen({ host: '127.0.0.1', port: config.port });
  // eslint-disable-next-line no-console
  console.log(`robot-islands auth server listening on 127.0.0.1:${config.port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('server failed to start:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

Run: `npm run build -w server`
Expected: clean compile; `server/dist/index.js` exists.

- [ ] **Step 3: Smoke-test the running server**

Prereq: prod DB exists (`su postgres -c 'createdb -O robot_islands robot_islands'`; pre-create extensions if needed — see Prerequisites).

Run (background):
```bash
cd server && DATABASE_URL=postgresql:///robot_islands COOKIE_SECURE=0 PORT=5180 node dist/index.js & echo $! > /tmp/ri-server.pid
sleep 1
curl -s -i -X POST localhost:5180/api/auth/signup -H 'content-type: application/json' -d '{"email":"smoke@test.local","password":"smoke-test-password"}'
```
Expected: `HTTP/1.1 201`, a `set-cookie: ri_session=...` header, body `{"id":"...","email":"smoke@test.local"}`.

Then verify `/me` and `/logout`, and stop the server:
```bash
COOKIE=$(curl -s -i -X POST localhost:5180/api/auth/login -H 'content-type: application/json' -d '{"email":"smoke@test.local","password":"smoke-test-password"}' | grep -i set-cookie | sed 's/.*\(ri_session=[^;]*\).*/\1/')
curl -s localhost:5180/api/auth/me -H "cookie: $COOKIE"      # -> {"id":...,"email":"smoke@test.local"}
curl -s -X POST localhost:5180/api/auth/logout -H "cookie: $COOKIE" -i | head -1   # -> 204
curl -s -o /dev/null -w '%{http_code}\n' localhost:5180/api/auth/me -H "cookie: $COOKIE"  # -> 401
kill "$(cat /tmp/ri-server.pid)"
```
Expected: `/me` returns the user, logout 204, post-logout `/me` 401.

- [ ] **Step 4: Verify the raw token is never stored**

Run: `su postgres -c "psql -d robot_islands -c \"SELECT encode(token_hash,'hex') FROM sessions LIMIT 1;\""`
Expected: a 64-char hex string (sha256), not a readable token.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): entry point — load config, migrate, listen on 127.0.0.1"
```

---

## Task 13: systemd unit + deploy notes

**Files:**
- Create: `server/deploy/robot-islands-server.service`
- Create: `server/deploy/README.md`

- [ ] **Step 1: Create the unit file**

```ini
# server/deploy/robot-islands-server.service
[Unit]
Description=Robot Islands auth/game server
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
WorkingDirectory=/root/robot-islands/server
EnvironmentFile=/root/robot-islands/server/.env
ExecStart=/usr/bin/node /root/robot-islands/server/dist/index.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create deploy notes**

```markdown
# Deploying the Robot Islands server

1. Build: `npm install && npm run build -w server`
2. Create `server/.env` from `.env.example` (set DATABASE_URL, PORT, COOKIE_SECURE=1).
3. Ensure DBs exist: `su postgres -c 'createdb -O robot_islands robot_islands'`
   (pre-create `pgcrypto`+`citext` extensions if the connecting role is not superuser).
4. Install the unit: `cp server/deploy/robot-islands-server.service /etc/systemd/system/`
   then `systemctl daemon-reload && systemctl enable --now robot-islands-server`.
5. (Later slice) nginx: add `location /api/ { proxy_pass http://127.0.0.1:5180; }`
   to the islands.nitjsefni.eu vhost.

Migrations run automatically on boot. This unit does NOT replace
robot-islands-dev.service (the Vite preview on :5173).
```

- [ ] **Step 3: Commit**

```bash
git add server/deploy/robot-islands-server.service server/deploy/README.md
git commit -m "chore(server): systemd unit + deploy notes (install manual)"
```

---

## Task 14: SPEC.md forward-reference

**Files:**
- Modify: `SPEC.md` (append a new appendix)

- [ ] **Step 1: Append the appendix stub**

Add at the end of `SPEC.md` (keep heading style consistent with existing appendices):

```markdown
## Appendix C — Server architecture (migration)

The server-authoritative migration (see `TODO.md`) moves the simulation
off the browser; the server owns all state and validates client intents.
It is being delivered in slices, each with its own design + plan under
`docs/superpowers/`. Slice 1 (auth service + user store) is specified in
`docs/superpowers/specs/2026-06-13-server-auth-slice-design.md` and adds a
standalone Node + Fastify server under `server/` with no change to the
simulation. §15.6 (pure client-side) remains in force until the runtime
slice moves game state server-side; this appendix will be expanded then.
```

- [ ] **Step 2: Commit**

```bash
git add SPEC.md
git commit -m "docs(spec): SPEC.md Appendix C — server migration forward-reference"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** repo layout → Task 1; data model/migrations → Tasks 5,6; scrypt → Task 3; tokens → Task 4; users/sessions repos → Tasks 8,9; cookie+guard → Task 10; HTTP surface (signup/login/logout/me, validation, rate-limit, generic login error, dummy-hash timing defense) → Task 11; config + test-DB guard → Tasks 2,7; deployment/systemd → Task 13; testing harness → Task 7; SPEC.md handling → Task 14; verification checklist → Task 11 step 6 + Task 12 steps 3–4. All §1–12 spec sections map to a task.

**Type consistency:** `Pool` (db.ts) used everywhere; `PublicUser`/`UserWithSecret`/`EmailTakenError` (users.ts) consumed in routes.ts; `ValidSession{userId,email}` (sessions.ts) consumed in guard.ts; `hashToken`→`Buffer` consistent across sessions/guard/routes; `SESSION_COOKIE`/`SESSION_TTL_MS` defined once in cookie.ts and imported in routes.ts/guard.ts; `buildApp(AppOptions{pool,cookieSecure})` defined in app.ts, used in index.ts + test-helpers.ts.

**Known ordering note:** `test-helpers.ts` (Task 7) imports `app.ts` (Task 11); Task 7 explicitly defers build verification to Task 11. Repo/route tests (Tasks 8–11) are the first point a full `npm test -w server` is meaningful.
