import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import type { Pool } from './db.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerGameRoutes } from './game/routes.js';
import { registerGameWsRoutes } from './game/ws.js';

export interface AppOptions { readonly pool: Pool; readonly cookieSecure: boolean; readonly allowedWsOrigins?: ReadonlyArray<string>; readonly authRateLimitMax?: number; readonly wsStatePushIntervalMs?: number; readonly wsIntentRateLimit?: number; readonly wsIntentRateWindowMs?: number; readonly wsCheckpointIntervalMs?: number; }

export function buildApp(opts: AppOptions): FastifyInstance {
  // trustProxy is the COUNT of trusted hops (a single nginx in front), NOT
  // `true`. With `true`, proxy-addr derives req.ip from the leftmost
  // X-Forwarded-For entry, which is fully client-controlled — an attacker
  // rotating XFF gets a fresh req.ip per request and bypasses the per-IP auth
  // rate limit (the brute-force / scrypt-DoS defense). `trustProxy: 1` trusts
  // exactly one proxy hop: Fastify takes the rightmost XFF entry (the address
  // nginx actually saw) and ignores anything the client appended beyond it.
  const app = Fastify({ logger: false, trustProxy: 1 });
  app.register(cookie);
  app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  app.register(async (instance) => {
    // Tighter limit on auth endpoints (per-IP). Overridable via
    // opts.authRateLimitMax (tests pass a high value so the suite doesn't 429).
    // trustProxy:1 at the root instance means `req.ip` is the address nginx
    // saw (rightmost XFF entry once nginx overwrites it with $remote_addr per
    // deploy/README.md); the per-IP limit therefore buckets on the real client
    // IP and a client cannot spoof it by injecting extra XFF entries.
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
    registerGameWsRoutes(instance, opts.pool, {
      allowedWsOrigins: opts.allowedWsOrigins,
      statePushIntervalMs: opts.wsStatePushIntervalMs,
      intentRateLimit: opts.wsIntentRateLimit,
      intentRateWindowMs: opts.wsIntentRateWindowMs,
      checkpointIntervalMs: opts.wsCheckpointIntervalMs,
    });
  });
  app.get('/health', async () => ({ ok: true }));
  return app;
}
