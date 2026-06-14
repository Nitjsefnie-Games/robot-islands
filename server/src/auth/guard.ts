import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db.js';
import { hashToken } from '../crypto/token.js';
import { findValidSession } from './sessions.js';
import { SESSION_COOKIE } from './cookie.js';

declare module 'fastify' {
  interface FastifyRequest { user?: { id: string; email: string }; }
}

/** Resolve the `ri_session` cookie on a request to a user identity, or null
 *  when absent/invalid/expired. The single cookie->session resolution path
 *  shared by the HTTP guard (`makeAuthGuard`) and the WebSocket upgrade
 *  (`ws.ts`) so the two can never drift on what "authenticated" means. */
export async function resolveSession(
  pool: Pool,
  req: FastifyRequest,
): Promise<{ id: string; email: string } | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = await findValidSession(pool, hashToken(token), new Date());
  if (!session) return null;
  return { id: session.userId, email: session.email };
}

/** Resolve the session cookie to req.user, or 401. Use as a route preHandler. */
export function makeAuthGuard(pool: Pool) {
  return async function authGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const user = await resolveSession(pool, req);
    if (!user) { await reply.code(401).send({ error: 'unauthorized' }); return; }
    req.user = user;
  };
}
