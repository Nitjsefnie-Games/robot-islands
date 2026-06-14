// server/src/game/routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';
import { createInitialSnapshot } from './new-game.js';
import { SCHEMA_VERSION } from '../../../src/persistence.js';

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

function makeValidSnapshot(): { v: number; savedAt: number; savedAtPerf: number; world: unknown; islandStates: unknown[] } {
  const snap = createInitialSnapshot(Date.now());
  return {
    v: SCHEMA_VERSION,
    savedAt: snap.savedAt,
    savedAtPerf: snap.savedAtPerf,
    world: snap.world as unknown,
    islandStates: snap.islandStates as unknown[],
  };
}

describe('game routes', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/game/state' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/game/new' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/game/import', payload: { snapshot: makeValidSnapshot() } })).statusCode).toBe(401);
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

  describe('POST /api/game/import', () => {
    it('imports a valid snapshot -> 201 + saved', async () => {
      const cookie = await authedCookie();
      const snapshot = makeValidSnapshot();
      const res = await app.inject({ method: 'POST', url: '/api/game/import', headers: { cookie }, payload: { snapshot } });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.islands.find((i: { id: string }) => i.id === 'home')).toBeDefined();
      // A second import on the same account is rejected.
      const dup = await app.inject({ method: 'POST', url: '/api/game/import', headers: { cookie }, payload: { snapshot } });
      expect(dup.statusCode).toBe(409);
    });

    it('rejects a malformed snapshot -> 400', async () => {
      const cookie = await authedCookie();
      const bad = await app.inject({ method: 'POST', url: '/api/game/import', headers: { cookie }, payload: { snapshot: { v: SCHEMA_VERSION } } });
      expect(bad.statusCode).toBe(400);
    });

    it('rejects an unsupported version -> 400', async () => {
      const cookie = await authedCookie();
      const snapshot = { ...makeValidSnapshot(), v: 1 };
      const res = await app.inject({ method: 'POST', url: '/api/game/import', headers: { cookie }, payload: { snapshot } });
      expect(res.statusCode).toBe(400);
    });
  });
});
