import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from './db.js';
import { registerAuthRoutes } from './auth/routes.js';

export interface AppOptions { readonly pool: Pool; readonly cookieSecure: boolean; }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.register(cookie);
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.register(async (instance) => {
    // Tighter limit on auth endpoints. Relaxed in plain-HTTP dev/test so the
    // integration suite can run multiple requests against the same app.
    await instance.register(rateLimit, {
      max: opts.cookieSecure ? 10 : 1000,
      timeWindow: '1 minute',
    });
    registerAuthRoutes(instance, opts.pool, opts.cookieSecure);
  });
  app.get('/health', async () => ({ ok: true }));
  return app;
}
