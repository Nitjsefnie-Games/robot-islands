// server/src/app.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb } from './test-helpers.js';
import { buildApp } from './app.js';

const pool = testPool();
const app = buildApp({ pool, cookieSecure: false, authRateLimitMax: 2 });
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

describe('buildApp', () => {
  it('the auth rate-limit buckets on the real connection IP (not a spoofable XFF)', async () => {
    // trustProxy:1 means req.ip is the address the single trusted proxy saw.
    // Under `inject` there is no proxy hop and the peer is always 127.0.0.1, so
    // every request below shares ONE bucket. We do NOT drive the bucket via a
    // client-supplied X-Forwarded-For — that is exactly the spoof the fix
    // closes. With authRateLimitMax:2 the third request must be 429.
    const first = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@x.com', password: 'a-strong-password' } });
    expect(first.statusCode).toBe(201);
    // Same email again would 409, but rate-limit counts the request first.
    const second = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@x.com', password: 'a-strong-password' } });
    expect(second.statusCode).toBe(409);
    const third = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'b@x.com', password: 'a-strong-password' } });
    expect(third.statusCode).toBe(429);
  });

  it('rotating the spoofable (leftmost) X-Forwarded-For entry does NOT escape the bucket', async () => {
    // Regression for the trustProxy:true XFF-spoof bypass. In production nginx
    // OVERWRITES X-Forwarded-For with $remote_addr (deploy/README.md), so the
    // app sees a single trusted entry per request. An attacker who tries to
    // inject EXTRA entries simulates the appending-proxy chain `<spoof>, <real>`
    // — and trustProxy:1 (one trusted hop) takes the RIGHTMOST entry (the real
    // peer nginx saw), ignoring the rotating leftmost spoof. So all three
    // requests bucket on 198.51.100.7 and the third 429s regardless of the
    // attacker's rotating leftmost value. Under trustProxy:true the leftmost
    // would have won and each request would have gotten a fresh bucket (201).
    const real = '198.51.100.7';
    const spoofed = (i: number) => ({ 'X-Forwarded-For': `9.9.9.${i}, ${real}` });
    const r1 = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: spoofed(1), payload: { email: 'p@x.com', password: 'a-strong-password' } });
    expect(r1.statusCode).toBe(201);
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: spoofed(2), payload: { email: 'q@x.com', password: 'a-strong-password' } });
    expect(r2.statusCode).toBe(201);
    const r3 = await app.inject({ method: 'POST', url: '/api/auth/signup', headers: spoofed(3), payload: { email: 'r@x.com', password: 'a-strong-password' } });
    expect(r3.statusCode).toBe(429);
  });
});
