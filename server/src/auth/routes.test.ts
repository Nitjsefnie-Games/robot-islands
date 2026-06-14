import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';

const pool = testPool();
const app = buildTestApp(pool);
beforeEach(() => resetDb(pool));
afterAll(async () => { await app.close(); await pool.end(); });

const GOOD = { email: 'player@x.com', password: 'a-strong-password' };

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const str = Array.isArray(raw) ? raw[0] : String(raw);
  return str.split(';')[0]!; // "ri_session=..."
}

describe('auth routes', () => {
  it('signup returns 201 + sets cookie + body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toBeTruthy();
    expect(res.json().email).toBe('player@x.com');
  });

  it('rejects short passwords with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'a@b.c', password: 'short' } });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate signup returns 409', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    expect(res.statusCode).toBe(409);
  });

  it('me returns the user when authenticated, 401 otherwise', async () => {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const cookie = cookieFrom(signup);
    const ok = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().email).toBe('player@x.com');
    const no = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(no.statusCode).toBe(401);
  });

  it('login wrong password 401, correct 200', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { ...GOOD, password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: GOOD });
    expect(good.statusCode).toBe(200);
  });

  it('login with unknown email 401 (no oracle)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@x.com', password: 'whatever-long' } });
    expect(res.statusCode).toBe(401);
  });

  it('logout revokes: me then returns 401', async () => {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: GOOD });
    const cookie = cookieFrom(signup);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });
});
