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
