// server/src/game/ws.test.ts
//
// End-to-end WebSocket transport tests. We listen on an ephemeral port and use
// a real `ws` client (transitively available via @fastify/websocket) — WS over
// Fastify's `inject` is not a supported path. The auth cookie is obtained the
// real way: POST /api/auth/signup -> Set-Cookie -> sent on the upgrade request.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { testPool, resetDb, buildTestApp } from '../test-helpers.js';
import { SCHEMA_VERSION } from '../../../src/persistence.js';

const pool = testPool();
const app = buildTestApp(pool);
let baseWsUrl = '';

beforeAll(async () => {
  await resetDb(pool);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  baseWsUrl = `ws://127.0.0.1:${addr.port}/api/game/ws`;
});
afterAll(async () => { await app.close(); await pool.end(); });

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0] : String(raw)).split(';')[0]!;
}

/** Sign up a fresh account, create its game, return the session cookie. */
async function authedCookieWithGame(email: string): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'a-strong-password' } });
  const cookie = cookieFrom(r);
  // A game must exist before intents can apply.
  await app.inject({ method: 'POST', url: '/api/game/new', headers: { cookie } });
  return cookie;
}

/** Resolve when the socket opens, or rejects the upgrade. An aborted upgrade
 *  surfaces as `unexpected-response` (HTTP status) or an `error`; a 101-then-
 *  close surfaces as `{ closed }`. */
function openOutcome(ws: WebSocket): Promise<'open' | { status: number } | { error: string } | { closed: number }> {
  return new Promise((resolve) => {
    ws.once('open', () => resolve('open'));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once('error', (e) => resolve({ error: String(e) }));
    ws.once('close', (code) => resolve({ closed: code }));
  });
}

/** For the authenticated cases — wait for the socket to be open. */
function awaitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });
}

/** Send one envelope and await its matching ack frame, ignoring any
 *  intervening `state` push messages (including the initial connect push). */
function sendAndAwait(ws: WebSocket, envelope: { seq: number } & Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seq = envelope.seq;
    const onMsg = (data: Buffer) => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(data.toString()); } catch (e) { reject(e); return; }
      // Skip periodic/intent-triggered state pushes; wait for the ack.
      if (parsed.type === 'state') {
        ws.once('message', onMsg);
        return;
      }
      if (parsed.seq === seq) {
        resolve(parsed);
        return;
      }
      // A message with a different seq could be a stray late ack; keep listening.
      ws.once('message', onMsg);
    };
    ws.once('message', onMsg);
    ws.send(JSON.stringify(envelope));
  });
}

/** Await the next message frame from the socket, with an optional timeout. */
function awaitMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`awaitMessage timed out after ${timeoutMs}ms`)), timeoutMs);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timer);
      try { resolve(JSON.parse(data.toString())); } catch (e) { reject(e); }
    });
  });
}

const PLACE = (seq: number) => ({
  type: 'place-building',
  payload: { islandId: 'home', defId: 'workshop', x: 0, y: 0, rotation: 0 },
  seq,
});

describe('game ws', () => {
  it('rejects an unauthenticated upgrade', async () => {
    const ws = new WebSocket(baseWsUrl); // no cookie
    const res = await openOutcome(ws);
    // The upgrade is aborted in preValidation with a 401 BEFORE it completes,
    // so the client never gets an open socket — it sees the HTTP 401 instead.
    expect(res).toMatchObject({ status: 401 });
    ws.close();
  });

  it('round-trips a legal place-building with matching seq and a projection', async () => {
    const cookie = await authedCookieWithGame('wsuser1@x.com');
    const ws = new WebSocket(baseWsUrl, { headers: { cookie } });
    await awaitOpen(ws);
    const ack = await sendAndAwait(ws, PLACE(42));
    expect(ack.seq).toBe(42);
    expect(ack.ok).toBe(true);
    expect(ack.projection).toBeDefined();
    expect((ack.projection as { islands: Array<{ id: string }> }).islands.some((i) => i.id === 'home')).toBe(true);
    ws.close();
  });

  it('returns ok:false for an unaffordable intent', async () => {
    const cookie = await authedCookieWithGame('wsuser2@x.com');
    const ws = new WebSocket(baseWsUrl, { headers: { cookie } });
    await awaitOpen(ws);
    const ack = await sendAndAwait(ws, {
      type: 'place-building',
      payload: { islandId: 'home', defId: 'deep_mine', x: 0, y: 0, rotation: 0 },
      seq: 5,
    });
    expect(ack.seq).toBe(5);
    expect(ack.ok).toBe(false);
    expect(typeof ack.error).toBe('string');
    ws.close();
  });

  it('serializes two back-to-back envelopes; both ack and the save is intact', async () => {
    const cookie = await authedCookieWithGame('wsuser3@x.com');
    const ws = new WebSocket(baseWsUrl, { headers: { cookie } });
    await awaitOpen(ws);

    // Collect the next two ack frames, then fire two placements at DIFFERENT
    // tiles back-to-back without awaiting in between (tests the per-connection
    // serialization chain — they must not race the same saves row). Ignore any
    // intervening state pushes (initial connect push + post-intent pushes).
    const acks: Array<Record<string, unknown>> = [];
    const got = new Promise<void>((resolve) => {
      const onMsg = (data: Buffer) => {
        const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
        if (parsed.type === 'state') return;
        acks.push(parsed);
        if (acks.length === 2) { ws.off('message', onMsg); resolve(); }
      };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ type: 'place-building', payload: { islandId: 'home', defId: 'workshop', x: 0, y: 0, rotation: 0 }, seq: 1 }));
    ws.send(JSON.stringify({ type: 'place-building', payload: { islandId: 'home', defId: 'workshop', x: 3, y: 0, rotation: 0 }, seq: 2 }));
    await got;

    const bySeq = new Map(acks.map((a) => [a.seq, a]));
    expect(bySeq.get(1)!.ok).toBe(true);
    expect(bySeq.get(2)!.ok).toBe(true);

    // The save isn't corrupted: a reload via the HTTP state route returns a
    // valid projection carrying BOTH placements' island (home).
    const cookieHeader = { cookie };
    const state = await app.inject({ method: 'GET', url: '/api/game/state', headers: cookieHeader });
    expect(state.statusCode).toBe(200);
    expect(state.json().islands.some((i: { id: string }) => i.id === 'home')).toBe(true);
    ws.close();
  });

  it('pushes a state message immediately on connect', async () => {
    const cookie = await authedCookieWithGame('wsstate1@x.com');
    const ws = new WebSocket(baseWsUrl, { headers: { cookie } });
    await awaitOpen(ws);
    const state = await awaitMessage(ws);
    expect(state.type).toBe('state');
    expect(state.snapshot).toBeDefined();
    expect((state.snapshot as { v: number }).v).toBe(SCHEMA_VERSION);
    expect((state.snapshot as { world: { islands: Array<{ id: string }> } }).world.islands.some((i) => i.id === 'home')).toBe(true);
    ws.close();
  });

  it('pushes a state message after a successful intent', async () => {
    const cookie = await authedCookieWithGame('wsstate2@x.com');
    const ws = new WebSocket(baseWsUrl, { headers: { cookie } });
    await awaitOpen(ws);
    await awaitMessage(ws); // consume initial state
    ws.send(JSON.stringify(PLACE(7)));
    const ack = await awaitMessage(ws);
    expect(ack.seq).toBe(7);
    expect(ack.ok).toBe(true);
    const state = await awaitMessage(ws);
    expect(state.type).toBe('state');
    expect((state.snapshot as { world: { islands: Array<{ id: string; buildings: Array<{ defId: string }> }> } }).world.islands.some(
      (i) => i.id === 'home' && i.buildings.some((b) => b.defId === 'workshop'),
    )).toBe(true);
    ws.close();
  });

  it('pushes a state message on the periodic tick', async () => {
    const cookie = await authedCookieWithGame('wsstate3@x.com');
    const tickPool = testPool();
    const tickApp = buildTestApp(tickPool, { wsStatePushIntervalMs: 50 });
    await tickApp.listen({ host: '127.0.0.1', port: 0 });
    const addr = tickApp.server.address() as AddressInfo;
    const url = `ws://127.0.0.1:${addr.port}/api/game/ws`;
    const ws = new WebSocket(url, { headers: { cookie } });
    await awaitOpen(ws);
    await awaitMessage(ws); // consume initial state
    const tick = await awaitMessage(ws, 1000);
    expect(tick.type).toBe('state');
    ws.close();
    await tickApp.close();
    await tickPool.end();
  });
});
