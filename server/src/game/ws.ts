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

export function registerGameWsRoutes(app: FastifyInstance, pool: Pool): void {
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
    let chain: Promise<void> = Promise.resolve();

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
      }).catch((err: unknown) => {
        // applyIntent already try/catches handler throws; this catch covers a
        // failure of the runner/persistence itself. Report, keep the socket up.
        const error = err instanceof Error ? err.message : 'internal error';
        try { socket.send(JSON.stringify({ seq: -1, ok: false, error })); } catch { /* socket gone */ }
      });
    });
  });
}
