// server/src/game/routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';

const pool = testPool();
const app = buildTestApp(pool);
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

const CREDS = { email: 'gamer@x.com', password: 'a-strong-password' };
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0]!;
}
async function authedCookie(): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: CREDS });
  return cookieFrom(r);
}

describe('game routes', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/game/state' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/game/new' })).statusCode).toBe(401);
  });

  it('new -> 201, duplicate -> 409', async () => {
    const cookie = await authedCookie();
    expect((await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } })).statusCode).toBe(409);
  });

  it('state -> 404 before new, projection after', async () => {
    const cookie = await authedCookie();
    expect((await app.inject({ method: 'GET', url: '/api/game/state', headers: { cookie } })).statusCode).toBe(404);
    await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } });
    const res = await app.inject({ method: 'GET', url: '/api/game/state', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().islands.find((i: { id: string }) => i.id === 'home')).toBeDefined();
  });
});
