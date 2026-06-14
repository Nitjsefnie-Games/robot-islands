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
