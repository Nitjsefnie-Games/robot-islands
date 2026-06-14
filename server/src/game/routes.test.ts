// server/src/game/routes.test.ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';
import { createInitialSnapshot } from './new-game.js';
import { clampImportSavedAt, MAX_OFFLINE_WINDOW_MS } from './routes.js';
import { SCHEMA_VERSION, type SaveSnapshot } from '../../../src/persistence.js';

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

    it('clamps a far-past savedAt so no unbounded offline catch-up is granted', async () => {
      const cookie = await authedCookie();
      // Snapshot claims it was saved 5 YEARS ago — a hand-crafted bid for a
      // multi-year offline windfall. The import must clamp the catch-up window
      // to MAX_OFFLINE_WINDOW_MS so the player gets at most that much catch-up.
      const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
      const base = createInitialSnapshot(Date.now());
      const ancient = { ...makeValidSnapshot(), savedAt: base.savedAt - fiveYearsMs };
      const res = await app.inject({
        method: 'POST', url: '/api/game/import', headers: { cookie }, payload: { snapshot: ancient },
      });
      expect(res.statusCode).toBe(201);

      // Read back the stored authoritative save. After import we re-stamp it at
      // `now` (loadAndCatchUp), so the durable savedAt is ~now regardless — the
      // important property is that the offline window used DURING import was
      // clamped, which clampImportSavedAt enforces (unit-asserted below). Here
      // we assert the state route returns and home exists (no crash from a
      // 5-year integrate, and no negative-time path).
      const state = await app.inject({ method: 'GET', url: '/api/game/state', headers: { cookie } });
      expect(state.statusCode).toBe(200);
      expect(state.json().islands.find((i: { id: string }) => i.id === 'home')).toBeDefined();
    });
  });

  describe('clampImportSavedAt', () => {
    const now = 1_000_000_000_000;
    function snapWith(savedAt: number, savedAtPerf: number): SaveSnapshot {
      const base = createInitialSnapshot(0) as SaveSnapshot;
      return { ...base, savedAt, savedAtPerf };
    }

    it('pulls a far-past savedAt forward to the window edge (window <= MAX)', () => {
      const fiveYears = 5 * 365 * 24 * 60 * 60 * 1000;
      const out = clampImportSavedAt(snapWith(now - fiveYears, 0), now);
      expect(out.savedAt).toBe(now - MAX_OFFLINE_WINDOW_MS);
      // savedAtPerf shifted by the same delta to keep the perf remap consistent.
      expect(out.savedAtPerf).toBe(0 + (out.savedAt - (now - fiveYears)));
      // Resulting offline window is exactly the cap, never multi-year.
      expect(now - out.savedAt).toBe(MAX_OFFLINE_WINDOW_MS);
    });

    it('clamps a far-future savedAt down to now (no negative replay)', () => {
      const out = clampImportSavedAt(snapWith(now + 5_000_000, 12345), now);
      expect(out.savedAt).toBe(now);
      expect(now - out.savedAt).toBe(0);
    });

    it('leaves an in-window savedAt untouched', () => {
      const inWindow = now - MAX_OFFLINE_WINDOW_MS / 2;
      const s = snapWith(inWindow, 999);
      const out = clampImportSavedAt(s, now);
      expect(out).toBe(s);
      expect(out.savedAt).toBe(inWindow);
      expect(out.savedAtPerf).toBe(999);
    });
  });
});
