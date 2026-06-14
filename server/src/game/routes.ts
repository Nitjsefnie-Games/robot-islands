// server/src/game/routes.ts
import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { makeAuthGuard } from '../auth/guard.js';
import { hasSave, saveSnapshot } from './persistence.js';
import { createInitialSnapshot } from './new-game.js';
import { loadAndCatchUp } from './runtime.js';
import { projectGame } from './projection.js';
import { deserializeWorld, isValidSaveSnapshot } from '../../../src/persistence.js';

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

  app.post('/api/game/import', { preHandler: guard }, async (req, reply) => {
    const userId = req.user!.id;
    if (await hasSave(pool, userId)) return reply.code(409).send({ error: 'game already exists' });
    const body = req.body as { snapshot?: unknown };
    const snapshot = body?.snapshot;
    if (!isValidSaveSnapshot(snapshot)) {
      return reply.code(400).send({ error: 'snapshot is missing, malformed, or unsupported version' });
    }
    // Deep-validate by attempting to deserialize. This catches corrupted inner
    // shapes without persisting junk into the authoritative store.
    try {
      deserializeWorld(snapshot, Date.now(), Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'invalid snapshot';
      return reply.code(400).send({ error: message });
    }
    await saveSnapshot(pool, userId, snapshot);
    const game = await loadAndCatchUp(pool, userId, Date.now());
    return reply.code(201).send(projectGame(game!));
  });

  app.get('/api/game/state', { preHandler: guard }, async (req, reply) => {
    const game = await loadAndCatchUp(pool, req.user!.id, Date.now());
    if (game === null) return reply.code(404).send({ error: 'no game' });
    return reply.code(200).send(projectGame(game));
  });
}
