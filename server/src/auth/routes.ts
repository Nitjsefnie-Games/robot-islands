import type { FastifyInstance } from 'fastify';
import type { Pool } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto/password.js';
import { generateToken, hashToken } from '../crypto/token.js';
import { createUser, findByEmail, EmailTakenError } from './users.js';
import { createSession, revokeSession } from './sessions.js';
import { setSessionCookie, clearSessionCookie, SESSION_COOKIE, SESSION_TTL_MS } from './cookie.js';
import { makeAuthGuard } from './guard.js';

// A throwaway hash to run verify against unknown emails (defeats timing oracle).
// hashPassword is now async (off-thread scrypt), so this is a Promise resolved
// once at module load and awaited in the login handler.
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
      const user = await createUser(pool, req.body.email, await hashPassword(req.body.password));
      setSessionCookie(reply, await issueSession(user.id), cookieOpts);
      return reply.code(201).send({ id: user.id, email: user.email });
    } catch (err) {
      if (err instanceof EmailTakenError) return reply.code(409).send({ error: 'email already registered' });
      throw err;
    }
  });

  app.post<{ Body: Creds }>('/api/auth/login', { schema: { body: credentialsSchema } }, async (req, reply) => {
    const user = await findByEmail(pool, req.body.email);
    // Constant-work: an unknown email still runs one scrypt verify against a
    // dummy hash so response time doesn't reveal whether the email exists.
    // DUMMY_HASH MUST use the current default scrypt params (see password.ts) so
    // this dummy verify costs the same as the real wrong-password path.
    let ok = false;
    if (user) {
      ok = await verifyPassword(user.password, req.body.password);
    } else {
      await verifyPassword(await DUMMY_HASH, req.body.password);
    }
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
