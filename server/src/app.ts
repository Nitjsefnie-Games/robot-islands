import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Pool } from './db.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerGameRoutes } from './game/routes.js';
import { registerGameWsRoutes } from './game/ws.js';

export interface AppOptions { readonly pool: Pool; readonly cookieSecure: boolean; readonly authRateLimitMax?: number; readonly wsStatePushIntervalMs?: number; }

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  app.register(cookie);
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.register(async (instance) => {
    // Tighter limit on auth endpoints (per-IP). Overridable via
    // opts.authRateLimitMax (tests pass a high value so the suite doesn't 429).
    // trustProxy is enabled at the root Fastify instance so `req.ip` reflects
    // the X-Forwarded-For value supplied by nginx; the per-IP limit therefore
    // buckets on the real client IP instead of the proxy.
    await instance.register(rateLimit, {
      max: opts.authRateLimitMax ?? 10,
      timeWindow: '1 minute',
    });
    registerAuthRoutes(instance, opts.pool, opts.cookieSecure);
  });
  registerGameRoutes(app, opts.pool);
  // WebSocket intent transport. The @fastify/websocket plugin must be loaded
  // before any route declared with `{ websocket: true }`; register the route
  // inside an encapsulated plugin scope that depends on it so ordering holds
  // regardless of when buildApp's synchronous body runs.
  app.register(async (instance) => {
    // Cap the WS frame size: intents are tiny envelopes, so 64 KiB is generous.
    // Without this, @fastify/websocket inherits ws's 100 MiB default — a cheap
    // memory-exhaustion vector for a hostile client.
    await instance.register(websocket, { options: { maxPayload: 65536 } });
    registerGameWsRoutes(instance, opts.pool, { statePushIntervalMs: opts.wsStatePushIntervalMs });
  });
  app.get('/health', async () => ({ ok: true }));
  return app;
}
