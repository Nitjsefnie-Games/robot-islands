// server/src/game/routes.ts
import type { FastifyInstance } from 'fastify';
import { type Pool, withAccountTx } from '../db.js';
import { makeAuthGuard } from '../auth/guard.js';
import { hasSave, saveSnapshot, loadSnapshot } from './persistence.js';
import { createInitialSnapshot } from './new-game.js';
import { loadAndCatchUp, catchUp } from './runtime.js';
import { projectGame } from './projection.js';
import { deserializeWorld, isValidSaveSnapshot, type SaveSnapshot } from '../../../src/persistence.js';

/** Largest offline gap an imported snapshot is allowed to claim. Import is a
 *  one-time migration of the player's OWN local save (TODO #4); `savedAt` is
 *  client-authored, so an attacker could set it far in the past to trigger a
 *  multi-year offline catch-up windfall. We clamp it into [now - this, now] on
 *  import so no unbounded offline bonus is granted. 24h matches the LOCAL
 *  client's effective offline horizon. */
export const MAX_OFFLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Clamp an imported snapshot's client-authored `savedAt`/`savedAtPerf` so the
 *  offline catch-up window (computed in deserializeWorld as
 *  `max(0, now - savedAt)`) cannot exceed MAX_OFFLINE_WINDOW_MS. A far-future
 *  `savedAt` collapses to 0 elapsed (no negative replay); a far-past one is
 *  pulled forward to the window edge. `savedAtPerf` is shifted by the same
 *  amount so the perf-domain remap stays consistent. */
export function clampImportSavedAt(snapshot: SaveSnapshot, now: number): SaveSnapshot {
  const earliest = now - MAX_OFFLINE_WINDOW_MS;
  const clampedSavedAt = Math.min(now, Math.max(earliest, snapshot.savedAt));
  if (clampedSavedAt === snapshot.savedAt) return snapshot;
  const delta = clampedSavedAt - snapshot.savedAt;
  return { ...snapshot, savedAt: clampedSavedAt, savedAtPerf: snapshot.savedAtPerf + delta };
}

export function registerGameRoutes(app: FastifyInstance, pool: Pool): void {
  const guard = makeAuthGuard(pool);

  app.post('/api/game/new', { preHandler: guard }, async (req, reply) => {
    const userId = req.user!.id;
    const game = await withAccountTx(pool, userId, async (client) => {
      if (await hasSave(client, userId)) return null;
      const now = Date.now();
      await saveSnapshot(client, userId, createInitialSnapshot(now));
      return loadAndCatchUp(client, userId, now);
    });
    if (game === null) return reply.code(409).send({ error: 'game already exists' });
    return reply.code(201).send(projectGame(game!));
  });

  app.post('/api/game/import', { preHandler: guard }, async (req, reply) => {
    const userId = req.user!.id;
    const body = req.body as { snapshot?: unknown };
    const rawSnapshot = body?.snapshot;
    if (!isValidSaveSnapshot(rawSnapshot)) {
      return reply.code(400).send({ error: 'snapshot is missing, malformed, or unsupported version' });
    }
    class ImportValidationError extends Error {}
    try {
      const game = await withAccountTx(pool, userId, async (client) => {
        if (await hasSave(client, userId)) return null;
        // TRUST BOUNDARY (SPEC Appendix C): import trusts the player's OWN local
        // save as a one-time migration; it is NOT a general anti-cheat-safe write
        // path (no content/reachability validation — out of scope). We DO clamp the
        // client-authored savedAt/savedAtPerf to [now - MAX_OFFLINE_WINDOW_MS, now]
        // so a hand-crafted far-past/far-future savedAt cannot mint an unbounded
        // offline catch-up windfall.
        const now = Date.now();
        const snapshot = clampImportSavedAt(rawSnapshot as SaveSnapshot, now);
        // Deep-validate by attempting to deserialize. This catches corrupted inner
        // shapes without persisting junk into the authoritative store.
        try {
          deserializeWorld(snapshot, now, now);
        } catch (err) {
          throw new ImportValidationError(err instanceof Error ? err.message : 'invalid snapshot');
        }
        await saveSnapshot(client, userId, snapshot);
        return loadAndCatchUp(client, userId, now);
      });
      if (game === null) return reply.code(409).send({ error: 'game already exists' });
      return reply.code(201).send(projectGame(game!));
    } catch (err) {
      if (err instanceof ImportValidationError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/api/game/state', { preHandler: guard }, async (req, reply) => {
    // READ-ONLY: project the advanced state without persisting. A plain state
    // read must reflect catch-up to `now` but must not commit it (the next
    // intent persists authoritatively). Idempotent at a fixed `now`.
    const now = Date.now();
    const game = catchUp(await loadSnapshot(pool, req.user!.id), now);
    if (game === null) return reply.code(404).send({ error: 'no game' });
    return reply.code(200).send(projectGame(game));
  });
}
