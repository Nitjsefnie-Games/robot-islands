// server/src/game/ws.ts
//
// The authenticated intent WebSocket (design §3 / §4). Route `/api/game/ws`:
//   - authenticate the UPGRADE via the `ri_session` cookie in a `preValidation`
//     hook, sharing the exact cookie->session resolution (`resolveSession`)
//     with the HTTP guard so the two never drift. Rejecting with a 401 in
//     preValidation aborts the upgrade BEFORE it is established (the client
//     sees an HTTP error, never an open socket).
//   - per message: parse a JSON envelope `{type,payload,seq}`, run it through
//     `applyIntent` against the account's authoritative state, send the ack.
//   - SERIALIZE: only one `applyIntent` runs at a time per connection (chained
//     on a per-connection promise) so two intents can't race the same `saves`
//     row.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import { type Pool, withAccountTx } from '../db.js';
import { DEFAULT_ALLOWED_WS_ORIGINS } from '../config.js';
import { resolveSession } from '../auth/guard.js';
import { applyIntent, type IntentEnvelope } from './intent-runner.js';
import { catchUp, loadAndCatchUp } from './runtime.js';
import { loadSnapshot } from './persistence.js';
import { serializeWorld } from '../../../src/persistence.js';
import { projectSnapshotForClient } from './projection.js';

/** Interval between periodic authoritative state pushes to the client.
 *  Chosen at ECONOMY_TICK_MS-scale (~1s) so the client sees production advance
 *  without acting. Injectable in tests via `registerGameWsRoutes` options. */
export const STATE_PUSH_INTERVAL_MS = 1000;

/** Per-connection intent rate limit: max accepted intent frames per rolling
 *  window. Each frame forces ≥1 Postgres write (loadAndCatchUp's saveSnapshot
 *  plus the post-intent pushState), so an unthrottled socket is a DB-write-
 *  amplification DoS. Legitimate play sends at most a handful of intents/sec
 *  (one per user action); 20/sec is generous headroom. */
export const WS_INTENT_RATE_LIMIT = 20;
export const WS_INTENT_RATE_WINDOW_MS = 1000;

/** Sustained-abuse threshold: this many consecutive over-limit frames closes
 *  the socket. A few bursts get a soft error ack; persistent flooding is hung
 *  up on (WS close code 1008 = policy violation). */
export const WS_ABUSE_CLOSE_THRESHOLD = 40;

/** Max concurrent authenticated WebSockets per account. More sockets let an
 *  attacker multiply the per-connection rate limit into aggregate DB pressure
 *  on the single saves row. */
export const WS_MAX_SOCKETS_PER_USER = 4;

/** Max wall-clock ms between read-only periodic pushes that are promoted to a
 *  persisting checkpoint. Without this, an idle socket re-integrates the full
 *  offline gap every second and `savedAt` never advances. */
export const WS_CHECKPOINT_INTERVAL_MS = 30000;

/** Options for the WS route registration. */
export interface GameWsOptions {
  /** Origins allowed to open the authenticated WS. Defaults to production + dev. */
  readonly allowedWsOrigins?: ReadonlyArray<string>;
  /** Override the periodic state-push interval (default 1000 ms). */
  readonly statePushIntervalMs?: number;
  /** Override the per-connection intent rate limit (default WS_INTENT_RATE_LIMIT). */
  readonly intentRateLimit?: number;
  /** Override the rate-limit window (default WS_INTENT_RATE_WINDOW_MS). */
  readonly intentRateWindowMs?: number;
  /** Override the checkpoint interval (default WS_CHECKPOINT_INTERVAL_MS). */
  readonly checkpointIntervalMs?: number;
}

/** A sliding-window rate limiter over message timestamps. `allow(now)` records
 *  the attempt and returns whether it is within the limit for the trailing
 *  window. Pure/testable; one instance per connection. */
export class SlidingWindowLimiter {
  private readonly times: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Record an attempt at `now` and return true if it is within the limit. */
  allow(now: number): boolean {
    const cutoff = now - this.windowMs;
    // Drop timestamps that have aged out of the window.
    while (this.times.length > 0 && this.times[0]! <= cutoff) this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

/** Per-account open sockets. Used to enforce WS_MAX_SOCKETS_PER_USER. */
const userSockets = new Map<string, Set<WebSocket>>();

/** Push the current authoritative snapshot to a socket without persisting.
 *  Returns the serialized snapshot (or null when the account has no game) so
 *  callers can assert on it in tests. */
async function pushStateReadOnly(
  socket: WebSocket,
  pool: Pool,
  userId: string,
  now: number,
): Promise<unknown | null> {
  // READ-ONLY projection: load + advance in memory but DO NOT persist. The
  // periodic push runs ~1 Hz per socket; persisting here would write the full
  // jsonb snapshot every second per connection (write amplification) and widen
  // the lost-update window. Authority is persisted only by accepted intents.
  const game = catchUp(await loadSnapshot(pool, userId), now);
  const snapshot = game === null ? null : serializeWorld(game.world, game.islandStates, now, now);
  socket.send(JSON.stringify({ type: 'state', snapshot: snapshot === null ? null : projectSnapshotForClient(snapshot) }));
  return snapshot;
}

/** Persisting checkpoint push: load, advance, and save under the per-account
 *  advisory lock. Called at most once per WS_CHECKPOINT_INTERVAL_MS so an idle
 *  socket doesn't re-integrate an ever-growing gap. The checkpoint carries no
 *  unpersisted mutation and is idempotent at a given `now`, so it cannot
 *  clobber a concurrent intent. */
async function pushStateCheckpoint(
  socket: WebSocket,
  pool: Pool,
  userId: string,
  now: number,
): Promise<unknown | null> {
  const game = await withAccountTx(pool, userId, (client) => loadAndCatchUp(client, userId, now));
  const snapshot = game === null ? null : serializeWorld(game.world, game.islandStates, now, now);
  socket.send(JSON.stringify({ type: 'state', snapshot: snapshot === null ? null : projectSnapshotForClient(snapshot) }));
  return snapshot;
}

/** Parse a raw WS frame into an envelope, or a per-message error descriptor
 *  when it isn't a valid one. We tolerate any JSON but require an envelope
 *  `type` string; a malformed frame yields an error ack, not a thrown
 *  connection. `seq` defaults to -1 when unparseable so the client can still
 *  correlate "something I sent was garbage". */
function parseEnvelope(raw: string): { env: IntentEnvelope } | { seq: number; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { seq: -1, error: 'malformed envelope' };
  }
  if (typeof data !== 'object' || data === null) return { seq: -1, error: 'malformed envelope' };
  const { type, payload, seq } = data as Record<string, unknown>;
  const safeSeq = typeof seq === 'number' ? seq : -1;
  if (typeof type !== 'string') return { seq: safeSeq, error: 'envelope.type must be a string' };
  return { env: { type, payload, seq: safeSeq } };
}

export function registerGameWsRoutes(
  app: FastifyInstance,
  pool: Pool,
  opts: GameWsOptions = {},
): void {
  app.get('/api/game/ws', {
    websocket: true,
    // Authenticate on the upgrade. Sending a 401 here aborts the upgrade before
    // it completes — the client never sees an open socket. Shares the cookie->
    // session path with makeAuthGuard via resolveSession.
    preValidation: async (req: FastifyRequest, reply) => {
      // CSWSH defense: browsers always send Origin on WS upgrades. Reject the
      // upgrade before it completes if the Origin is missing or untrusted.
      const origin = req.headers.origin;
      const allowed = opts.allowedWsOrigins ?? DEFAULT_ALLOWED_WS_ORIGINS;
      if (!origin || !allowed.includes(origin)) {
        await reply.code(403).send({ error: 'forbidden origin' });
        return;
      }
      const user = await resolveSession(pool, req);
      if (!user) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      req.user = user;
    },
  }, async (socket: WebSocket, req: FastifyRequest) => {
    // preValidation guarantees req.user is set by the time the handler runs.
    const userId = req.user!.id;

    // Enforce the per-account socket cap to prevent an attacker from multiplying
    // the per-connection rate limit into aggregate DB pressure.
    const socketsForUser = userSockets.get(userId) ?? new Set<WebSocket>();
    userSockets.set(userId, socketsForUser);
    socketsForUser.add(socket);
    if (socketsForUser.size > WS_MAX_SOCKETS_PER_USER) {
      socket.close(1008, 'too many connections');
      socketsForUser.delete(socket);
      if (socketsForUser.size === 0) userSockets.delete(userId);
      return;
    }

    // Per-connection serialization: every incoming message chains onto the
    // previous one's promise so at most one applyIntent is in flight. This is
    // what prevents two intents from racing (load->apply->persist) the same row.
    // The periodic state push also chains onto this queue so a tick and an
    // intent can never race the same saves row.
    let chain: Promise<void> = Promise.resolve();

    // Push the initial authoritative snapshot immediately on connect. If the
    // account has no game yet, snapshot is null; the client can use that as a
    // signal to create one (slice-4 boot will show auth/new-game UI).
    chain = chain.then(async () => { await pushStateReadOnly(socket, pool, userId, Date.now()); }).catch(() => { /* socket gone */ });

    // Periodic authoritative state push: production advances even when the
    // client sends no intents. The interval is cleared on socket close.
    const pushIntervalMs = opts.statePushIntervalMs ?? STATE_PUSH_INTERVAL_MS;
    const checkpointIntervalMs = opts.checkpointIntervalMs ?? WS_CHECKPOINT_INTERVAL_MS;
    let lastCheckpointMs = 0;
    const tickInterval = setInterval(() => {
      chain = chain.then(async () => {
        const now = Date.now();
        if (now - lastCheckpointMs >= checkpointIntervalMs) {
          await pushStateCheckpoint(socket, pool, userId, now);
          lastCheckpointMs = now;
        } else {
          await pushStateReadOnly(socket, pool, userId, now);
        }
      }).catch(() => { /* socket gone */ });
    }, pushIntervalMs);
    socket.on('close', () => {
      clearInterval(tickInterval);
      socketsForUser.delete(socket);
      if (socketsForUser.size === 0) userSockets.delete(userId);
    });

    // Per-connection intent rate limiter. Excess frames get a cheap error ack
    // WITHOUT chaining an applyIntent (so a flood can't amplify into DB writes);
    // sustained abuse closes the socket. Limited frames don't reach Postgres.
    const limiter = new SlidingWindowLimiter(
      opts.intentRateLimit ?? WS_INTENT_RATE_LIMIT,
      opts.intentRateWindowMs ?? WS_INTENT_RATE_WINDOW_MS,
    );
    let consecutiveOverLimit = 0;

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
      // Rate-limit BEFORE chaining the expensive load->apply->persist so a
      // flooding client cannot grow the in-memory chain or hit the DB.
      if (!limiter.allow(Date.now())) {
        consecutiveOverLimit += 1;
        // Correlate the rejection to the frame's seq when parseable.
        const seq = (() => {
          try {
            const d = JSON.parse(text) as Record<string, unknown>;
            return typeof d.seq === 'number' ? d.seq : -1;
          } catch { return -1; }
        })();
        try { socket.send(JSON.stringify({ seq, ok: false, error: 'rate limit exceeded' })); } catch { /* socket gone */ }
        if (consecutiveOverLimit >= WS_ABUSE_CLOSE_THRESHOLD) {
          try { socket.close(1008, 'rate limit'); } catch { /* socket gone */ }
        }
        return;
      }
      consecutiveOverLimit = 0;
      chain = chain.then(async () => {
        const parsed = parseEnvelope(text);
        if ('error' in parsed) {
          socket.send(JSON.stringify({ seq: parsed.seq, ok: false, error: parsed.error }));
          return;
        }
        const ack = await applyIntent(pool, userId, parsed.env, Date.now());
        socket.send(JSON.stringify(ack));
        // After every accepted intent, push the fresh authoritative snapshot
        // IN ADDITION to the ack. The ack keeps its existing projection field
        // for slice-3 back-compat; the state push carries the full snapshot.
        // This push is best-effort: the intent is ALREADY durably committed by
        // applyIntent and the ack is already sent. Swallow a push failure in its
        // own try/catch so it can't fall through to the chain's `.catch` and
        // manufacture a spurious {seq:-1,ok:false} failure frame for an intent
        // that actually succeeded — the next periodic tick re-pushes anyway.
        if (ack.ok) {
          try {
            await pushStateReadOnly(socket, pool, userId, Date.now());
          } catch { /* best-effort; next periodic tick re-pushes */ }
        }
      }).catch((err: unknown) => {
        // applyIntent already try/catches handler throws; this catch covers a
        // failure of the runner/persistence itself. Report, keep the socket up.
        const error = err instanceof Error ? err.message : 'internal error';
        try { socket.send(JSON.stringify({ seq: -1, ok: false, error })); } catch { /* socket gone */ }
      });
    });
  });
}
