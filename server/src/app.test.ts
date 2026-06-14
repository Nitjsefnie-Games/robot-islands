// server/src/app.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from './test-helpers.js';
import { buildApp } from './app.js';

const pool = testPool();
const app = buildApp({ pool, cookieSecure: false, authRateLimitMax: 2 });
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

describe('buildApp', () => {
  it('trustProxy makes the auth rate-limit bucket on X-Forwarded-For', async () => {
    // With authRateLimitMax: 2, the third request from the same client IP must
    // be rate-limited. X-Forwarded-For supplies the synthetic IP so the test is
    // deterministic regardless of Fastify's default fallback.
    const headers = { 'X-Forwarded-For': '203.0.113.42' };
    const first = await app.inject({ method: 'POST', url: '/api/auth/signup', headers, payload: { email: 'a@x.com', password: 'a-strong-password' } });
    expect(first.statusCode).toBe(201);
    // Same email again would 409, but rate-limit counts the request first.
    const second = await app.inject({ method: 'POST', url: '/api/auth/signup', headers, payload: { email: 'a@x.com', password: 'a-strong-password' } });
    expect(second.statusCode).toBe(409);
    const third = await app.inject({ method: 'POST', url: '/api/auth/signup', headers, payload: { email: 'b@x.com', password: 'a-strong-password' } });
    expect(third.statusCode).toBe(429);

    // A different IP is not blocked by the first bucket.
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
      payload: { email: 'c@x.com', password: 'a-strong-password' },
    });
    expect(other.statusCode).toBe(201);
  });
});
