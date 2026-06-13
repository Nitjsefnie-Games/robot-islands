# Design spec — Server migration slice 1: Auth service + user store

**Date:** 2026-06-13
**Status:** Approved for planning
**Part of:** the server-authoritative migration (TODO.md). This is the
**first of ~5 slices**; each gets its own spec → plan → implementation cycle.

---

## Context

The TODO.md "server-authoritative migration" moves the simulation off the
browser: the server owns all state and validates client intents (anti-cheat +
future player interactions). That migration decomposes into ~5 sub-projects:

1. **Server runtime + persistence** — Node service hosting the pure layer behind a DB.
2. **Transport + intent protocol** — socket/WS, intent validation, authoritative broadcast.
3. **Authentication / accounts** *(this slice)* — the identity the server keys saves and anti-cheat on.
4. **Client refactor** — browser becomes display + intent-sender.
5. **Trust-surface hardening** — `as unknown as` readonly casts, trade/XP paths.

Owner chose to build **auth first** (TODO #7: accounts are the identity
everything else hangs off). This spec covers **only** standing up the auth
service + user/session store. No game-state hosting, no intent loop, no client
changes yet.

## Decision

Build a **standalone Node + Fastify server** providing email+password accounts
with **server-side revocable sessions**, backed by the box's existing
**PostgreSQL** (cluster 17, 5432). Passwords hashed with **Node's built-in
scrypt** (zero native deps). The Vite client is untouched this slice; the
server is verified standalone via vitest integration tests + localhost curl.

**Deliberately NOT in this slice:** game-state hosting, WebSockets/intents,
client login UI, email verification, password reset, nginx public exposure.

---

## 1. Background — what already exists on this box

Verified during brainstorming:

- **Postgres 17.9** is up (cluster 17 on port 5432; cluster 13 on 5433 is
  `down`). `pg_hba`: `local all all peer`, `host all root 127.0.0.1 trust`,
  `host all all 127.0.0.1 md5`.
- A **`robot_islands` role** exists (login, has a password, non-superuser) and
  owns an already-provisioned **`robot_islands_dev`** database.
- An **existing cross-service auth convention** exists but is the **wrong
  shape** for this slice: human-login creds live in `goonbot.users.config`
  (jsonb), keyed by Discord integer `user_id`, **1 user (the owner)**, hashed
  PBKDF2-HMAC-SHA256/200k, with stateless HMAC-signed session cookies
  (`<uid>.<ts>.<nonce>.<hmac>`, shared `SESSION_SECRET`). docs-hub reuses it.
  - It is **Discord-keyed, single-owner, no email, no self-signup** → robot-
    islands needs its **own** email-keyed users table regardless. We adopt a
    **stronger** convention (scrypt + revocable server-side sessions) because
    the anti-cheat rationale driving the migration favours revocation/ban.
- Box convention for DB access: services run as **root** via socket peer
  (`postgresql:///<db>`), zero password to manage. We follow it.

## 2. Decisions captured (brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| First slice | Auth / accounts | Owner's call; accounts key everything (TODO #7). |
| Slice scope | Auth service + user store only | Focused, shippable; no game state yet. |
| Auth method | Email + password, self-managed | No third-party dependency on a self-hosted box. |
| User store | PostgreSQL (existing, cluster 17) | Already up; scales to the eventual save store. |
| Password hashing | **scrypt** (`node:crypto`, built-in) | Memory-hard, zero native deps, TS-clean. |
| Session model | **Server-side sessions table** (opaque token) | Revocable — fits anti-cheat (ban/kill session). |
| Server stack | **Fastify** | TS-first, schema validation, clean WS path for later slices. |
| Repo layout | `server/` dir + **npm workspaces** | Lets the server import the pure `src/` layer later. |
| Email verification / reset | **Deferred** | No SMTP confirmed; single owner; YAGNI. |
| DB connection | socket-peer-as-root (`postgresql:///robot_islands`) | Box convention; root code-exec owns the box regardless, so a least-privilege role adds friction without changing the threat model. |
| nginx public exposure | **Deferred** | No client consumes the API this slice; verify via localhost. |

## 3. Repo layout (npm workspaces)

Convert the repo root to npm workspaces so the server is its own package and
can import the pure `src/` layer in later slices.

```
robot-islands/
  package.json            # + "workspaces": ["server"]  (client config unchanged)
  src/                    # unchanged
  server/
    package.json          # deps: fastify, @fastify/cookie, @fastify/rate-limit, pg
                          # devDeps: typescript, vitest, @types/node, @types/pg, tsx
    tsconfig.json         # strict, noUncheckedIndexedAccess, noUnusedLocals/Parameters
    .env.example          # DATABASE_URL, PORT, COOKIE_SECURE
    .gitignore            # .env, dist/
    migrations/
      0001_init.sql       # schema_migrations, users, sessions
    src/
      index.ts            # boot Fastify, register plugins + routes, run migrations, listen
      config.ts           # parse + validate env
      db.ts               # pg Pool from DATABASE_URL
      migrate.ts          # numbered-SQL migration runner (tracks schema_migrations)
      crypto/
        password.ts       # scrypt hash/verify (pure, dep-free)
        password.test.ts
        token.ts          # opaque token gen + sha256 (pure, dep-free)
        token.test.ts
      auth/
        users.ts          # user repo: create / findByEmail / findById
        sessions.ts       # session repo: create / findValidByTokenHash / revoke / purgeExpired
        cookie.ts         # set/clear session cookie helpers
        guard.ts          # Fastify preHandler: cookie -> valid session -> req.user
        routes.ts         # POST signup|login|logout, GET me
        auth.test.ts      # integration tests against robot_islands_test
```

**Separation of concerns** (mirrors `src/` discipline): pure crypto
(`crypto/*`, no DB, no Fastify) → DB repos (`auth/users.ts`,
`auth/sessions.ts`, no Fastify) → HTTP (`auth/routes.ts`, `auth/guard.ts`).
Each unit is independently testable.

## 4. Data model (Postgres)

**Databases:** `robot_islands` (prod, **to create**), `robot_islands_dev`
(exists, dev), `robot_islands_test` (**to create**, vitest). All owned per the
box's root-peer convention; `gen_random_uuid()` and `citext` require
`CREATE EXTENSION IF NOT EXISTS pgcrypto;` and `citext;` (run in migration
0001).

```sql
CREATE TABLE schema_migrations (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      citext UNIQUE NOT NULL,
  password   text NOT NULL,           -- PHC-style: scrypt$N=...,r=...,p=...$salt_b64$hash_b64
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,  -- sha256(opaque token); raw token NEVER stored
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz            -- NULL = active; set to revoke/ban
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
```

- `citext` → case-insensitive unique email.
- `password` is a self-describing **PHC-style** string so scrypt params can be
  upgraded later without a schema change.
- Storing only `sha256(token)` means a DB read can't resume sessions.

## 5. Crypto

- **Password** (`crypto/password.ts`): `scryptSync(password, salt, 32, {N:2**15, r:8, p:1, maxmem:64*1024*1024})`,
  random 16-byte salt. Encode as `scrypt$N=32768,r=8,p=1$<salt_b64url>$<hash_b64url>`.
  `verify(stored, password)` parses params, recomputes, compares with
  `crypto.timingSafeEqual`. Password length bounds enforced at the route layer
  (12–200 chars) before hashing.
- **Session token** (`crypto/token.ts`): `randomBytes(32)` → base64url (cookie
  value). `hashToken(raw)` = `createHash('sha256').update(raw).digest()`
  (bytea). DB lookup hashes the incoming cookie and matches `token_hash`.

## 6. HTTP surface (`/api/auth`)

| Method | Path | Body | Success | Failure |
|---|---|---|---|---|
| POST | `/api/auth/signup` | `{email, password}` | 201 + `Set-Cookie` + `{id, email}` | 409 email taken; 400 invalid |
| POST | `/api/auth/login` | `{email, password}` | 200 + `Set-Cookie` + `{id, email}` | 401 generic |
| POST | `/api/auth/logout` | — (cookie) | 204 + cleared cookie (session revoked) | 204 even if no session |
| GET | `/api/auth/me` | — (cookie) | 200 `{id, email}` | 401 |

- **Cookie**: name `ri_session`, value = raw opaque token, `HttpOnly`,
  `Secure` (when `COOKIE_SECURE=1`), `SameSite=Lax`, `Path=/`, `Max-Age` 30d.
- **Validation**: Fastify JSON schemas — email format, password length 12–200.
- **Rate limit**: `@fastify/rate-limit` on `/login` + `/signup`, per-IP
  (e.g. 10/min). Global generous default elsewhere.
- **Login failures are generic** ("invalid email or password") — no
  user-exists oracle. To defeat timing oracles, login runs a scrypt verify
  against a dummy hash when the email is unknown.
- **Signup conflict** returns 409 — a deliberate, documented enumeration
  trade-off acceptable for a single-owner hobby box.
- `guard.ts` preHandler: read `ri_session` → `hashToken` → `sessions.findValidByTokenHash`
  (active, unexpired) → attach `req.user = {id,email}`; else 401. Touches
  `last_seen_at` opportunistically.

## 7. Configuration & deployment

- **Env** (`server/.env`, gitignored; `.env.example` committed):
  `DATABASE_URL` (default `postgresql:///robot_islands`), `PORT` (default
  `5180`), `COOKIE_SECURE` (default `1`).
- **Migrations** run on boot (`migrate.ts` applies pending `migrations/*.sql`
  in version order inside a transaction, recording `schema_migrations`).
- **systemd**: `robot-islands-server.service` runs the built server
  (`node server/dist/index.js`) on `127.0.0.1:5180`, `WorkingDirectory` the
  repo root, `Restart=on-failure`. Does **not** touch `robot-islands-dev.service`.
  Unit file committed under `server/deploy/` and installed manually.
- **nginx**: deferred. When the client consumes the API (later slice), add a
  `location /api/ { proxy_pass http://127.0.0.1:5180; }` stanza to the
  `islands.nitjsefni.eu` vhost.

## 8. Testing (vitest)

- **Pure unit** (no DB): `password.test.ts` (hash ≠ plaintext, verify
  roundtrip, wrong password fails, PHC parse, params encoded), `token.test.ts`
  (token uniqueness/length, hash determinism, raw ≠ hash).
- **Integration** (`auth.test.ts`, against `robot_islands_test`): signup →
  `/me` returns user; duplicate email → 409; login wrong password → 401; login
  correct → cookie + `/me`; logout → session revoked, subsequent `/me` → 401;
  expired session rejected; revoked session rejected; raw token absent from
  `sessions` (only hash present). Harness runs migrations once, `TRUNCATE
  users, sessions RESTART IDENTITY CASCADE` between tests.
- **Test DB selection** via `DATABASE_URL` env override pointing at
  `robot_islands_test`; tests refuse to run against a non-`_test` DB as a
  guard.
- Root `npm test` (client/pure layer) stays green; server tests run from the
  `server` workspace (`npm test -w server`).

## 9. SPEC.md handling

This slice adds server **infrastructure** and changes **no simulation
mechanic**, so SPEC.md gets only a short forward-reference: a new
"Appendix C — Server architecture (migration)" stub naming the migration and
pointing at this design doc + TODO.md. The §15.6 "pure client-side"
supersession is **deferred** to the runtime slice that actually moves game
state server-side — not flipped here.

## 10. Verification checklist

- `npm install` at root resolves workspaces; `npm run build -w server` compiles clean under strict TS.
- `npm test -w server` green (unit + integration); root `npm test` still green.
- `createdb robot_islands && createdb robot_islands_test` (as the box's pg root); boot applies migration 0001.
- `curl -i -X POST localhost:5180/api/auth/signup -d '{"email":"a@b.c","password":"<12+ chars>"}' -H 'content-type: application/json'` → 201 + `Set-Cookie: ri_session=…`.
- `curl` `/me` with that cookie → 200 `{id,email}`; without → 401.
- `curl` `/logout` then `/me` with the same cookie → 401.
- `psql robot_islands -c 'select token_hash from sessions'` shows bytea hashes, never the raw cookie value.

## 11. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| npm-workspaces conversion disturbs the Vite client build/dev service | MED | Client `package.json`/scripts unchanged; only add `workspaces`; verify `npm run build` + the existing dev service still serve `dist/`. |
| scrypt CPU cost blocks the event loop under load | LOW | Single-owner now; `scryptSync` acceptable. Move to async `scrypt` if multi-user load arrives. |
| Stateless-vs-stateful session mistakes leak/over-retain | LOW | Server-side table is the single source of truth; only `sha256(token)` stored; logout/ban set `revoked_at`. |
| Email enumeration via signup 409 | LOW | Accepted + documented for single-owner box; revisit when multi-player opens signup. |
| Test run against a real DB | MED | Tests refuse any `DATABASE_URL` whose db name doesn't end in `_test`; truncate (not drop) between tests. |

## 12. Out of scope (named, not missed)

- **Game-state hosting / intents / WebSockets** → slices 1-runtime & 2-transport.
- **Client login UI + API wiring** → slice 4 (client refactor).
- **Email verification + password reset** → later (needs SMTP).
- **nginx public exposure** → when the client consumes the API.
- **Least-privilege DB role** → deferred; box runs services as root by convention.
- **Importing the existing `goonbot.users` owner identity** → out of shape; not reused.
