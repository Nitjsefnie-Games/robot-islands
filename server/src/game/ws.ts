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
import type { Pool } from '../db.js';
import { resolveSession } from '../auth/guard.js';
import { applyIntent, type IntentEnvelope } from './intent-runner.js';
import { loadAndCatchUp } from './runtime.js';
import { serializeWorld } from '../../../src/persistence.js';

/** Interval between periodic authoritative state pushes to the client.
 *  Chosen at ECONOMY_TICK_MS-scale (~1s) so the client sees production advance
 *  without acting. Injectable in tests via `registerGameWsRoutes` options. */
export const STATE_PUSH_INTERVAL_MS = 1000;

/** Options for the WS route registration. */
export interface GameWsOptions {
  /** Override the periodic state-push interval (default 1000 ms). */
  readonly statePushIntervalMs?: number;
}

/** Push the current authoritative snapshot to a socket. Returns the serialized
 *  snapshot (or null when the account has no game) so callers can assert on it
 *  in tests. */
async function pushState(
  socket: import('ws').default,
  pool: Pool,
  userId: string,
): Promise<unknown | null> {
  const game = await loadAndCatchUp(pool, userId, Date.now());
  const snapshot = game === null ? null : serializeWorld(game.world, game.islandStates, Date.now(), Date.now());
  socket.send(JSON.stringify({ type: 'state', snapshot }));
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
      const user = await resolveSession(pool, req);
      if (!user) { await reply.code(401).send({ error: 'unauthorized' }); return; }
      req.user = user;
    },
  }, async (socket, req: FastifyRequest) => {
    // preValidation guarantees req.user is set by the time the handler runs.
    const userId = req.user!.id;

    // Per-connection serialization: every incoming message chains onto the
    // previous one's promise so at most one applyIntent is in flight. This is
    // what prevents two intents from racing (load->apply->persist) the same row.
    // The periodic state push also chains onto this queue so a tick and an
    // intent can never race the same saves row.
    let chain: Promise<void> = Promise.resolve();

    // Push the initial authoritative snapshot immediately on connect. If the
    // account has no game yet, snapshot is null; the client can use that as a
    // signal to create one (slice-4 boot will show auth/new-game UI).
    chain = chain.then(async () => { await pushState(socket, pool, userId); }).catch(() => { /* socket gone */ });

    // Periodic authoritative state push: production advances even when the
    // client sends no intents. The interval is cleared on socket close.
    const pushIntervalMs = opts.statePushIntervalMs ?? STATE_PUSH_INTERVAL_MS;
    const tickInterval = setInterval(() => {
      chain = chain.then(async () => { await pushState(socket, pool, userId); }).catch(() => { /* socket gone */ });
    }, pushIntervalMs);
    socket.on('close', () => { clearInterval(tickInterval); });

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString();
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
        if (ack.ok) {
          await pushState(socket, pool, userId);
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
