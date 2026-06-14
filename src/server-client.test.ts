// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type GameServerClient,
  connectGameServer,
  gameSocketUrl,
} from './server-client.js';

/** Minimal fake WebSocket implementing the subset used by `connectGameServer`. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  private pendingSend: Array<string> = [];
  private closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  addEventListener<K extends 'open' | 'message' | 'close' | 'error'>(
    type: K,
    listener: (ev: unknown) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener<K extends 'open' | 'message' | 'close' | 'error'>(
    type: K,
    listener: (ev: unknown) => void,
  ): void {
    const list = this.listeners[type];
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Test helper: advance the socket to OPEN and fire listeners. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    const ev = new Event('open');
    if (this.onopen) this.onopen(ev);
    for (const fn of this.listeners.open ?? []) fn(ev);
  }

  /** Test helper: deliver a `{ data }` message event to listeners. */
  receiveMessage(data: string): void {
    const ev = new MessageEvent('message', { data });
    if (this.onmessage) this.onmessage(ev);
    for (const fn of this.listeners.message ?? []) fn(ev);
  }

  /** Test helper: close the socket from the server side and fire listeners. */
  serverClose(code = 1006, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    const ev = new CloseEvent('close', { code, reason, wasClean: code === 1000 });
    if (this.onclose) this.onclose(ev);
    for (const fn of this.listeners.close ?? []) fn(ev);
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== 'string') throw new Error('FakeWebSocket only supports string sends');
    this.pendingSend.push(data);
  }

  close(): void {
    this.serverClose(1000, 'client close');
  }

  getSent(): readonly string[] {
    return this.pendingSend;
  }

  clearSent(): void {
    this.pendingSend = [];
  }
}

describe('gameSocketUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns wss for https pages', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.com:8443' });
    expect(gameSocketUrl()).toBe('wss://example.com:8443/api/game/ws');
  });

  it('returns ws for http pages', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    expect(gameSocketUrl()).toBe('ws://localhost:5173/api/game/ws');
  });
});

describe('connectGameServer', () => {
  let createdSockets: FakeWebSocket[] = [];
  let statuses: string[] = [];
  let states: Array<unknown | null> = [];
  let client: GameServerClient | null = null;

  function createRecordingFakeWebSocket(): typeof WebSocket {
    return class extends FakeWebSocket {
      constructor(url: string | URL) {
        super(url);
        createdSockets.push(this);
      }
    } as unknown as typeof WebSocket;
  }

  beforeEach(() => {
    createdSockets = [];
    statuses = [];
    states = [];
    // Empty.
  });

  afterEach(() => {
    client?.close();
    client = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function makeClient(url = 'ws://test/ws'): GameServerClient {
    client = connectGameServer({
      url,
      onState: (s) => states.push(s),
      onStatus: (s) => statuses.push(s),
      WebSocketCtor: createRecordingFakeWebSocket(),
    });
    return client;
  }

  function lastSocket(): FakeWebSocket {
    expect(createdSockets.length).toBeGreaterThan(0);
    return createdSockets[createdSockets.length - 1]!;
  }

  it('resolves sendIntent with the ack matching its seq', async () => {
    const c = makeClient();
    lastSocket().open();

    const p = c.sendIntent('build', { x: 1, y: 2 });
    expect(lastSocket().getSent()).toHaveLength(1);
    const sent = JSON.parse(lastSocket().getSent()[0]!);
    expect(sent).toEqual({ type: 'build', payload: { x: 1, y: 2 }, seq: 1 });

    lastSocket().receiveMessage(JSON.stringify({ seq: 1, ok: true, projection: { x: 1 } }));
    const ack = await p;
    expect(ack).toEqual({ seq: 1, ok: true, projection: { x: 1 } });
  });

  it('correlates two concurrent intents to their respective acks', async () => {
    const c = makeClient();
    lastSocket().open();

    const p1 = c.sendIntent('a', { n: 1 });
    const p2 = c.sendIntent('b', { n: 2 });

    const sent = lastSocket().getSent();
    expect(sent).toHaveLength(2);
    const s1 = JSON.parse(sent[0]!);
    const s2 = JSON.parse(sent[1]!);
    expect(s1.seq).toBe(1);
    expect(s2.seq).toBe(2);

    // Deliver acks out of order.
    lastSocket().receiveMessage(JSON.stringify({ seq: 2, ok: true, projection: { b: 2 } }));
    lastSocket().receiveMessage(JSON.stringify({ seq: 1, ok: false, error: 'nope' }));

    const [ack1, ack2] = await Promise.all([p1, p2]);
    expect(ack1).toEqual({ seq: 1, ok: false, error: 'nope' });
    expect(ack2).toEqual({ seq: 2, ok: true, projection: { b: 2 } });
  });

  it('invokes onState for incoming state frames', () => {
    makeClient();
    lastSocket().open();

    lastSocket().receiveMessage(JSON.stringify({ type: 'state', snapshot: { foo: 'bar' } }));
    expect(states).toEqual([{ foo: 'bar' }]);

    lastSocket().receiveMessage(JSON.stringify({ type: 'state', snapshot: null }));
    expect(states).toEqual([{ foo: 'bar' }, null]);
  });

  it('ignores malformed frames without throwing', () => {
    makeClient();
    lastSocket().open();

    lastSocket().receiveMessage('not json');
    lastSocket().receiveMessage('{');
    lastSocket().receiveMessage(JSON.stringify({ type: 'state', snapshot: 42 }));

    expect(states).toEqual([42]);
  });

  it('rejects sendIntent when the socket closes before the ack', async () => {
    const c = makeClient();
    lastSocket().open();

    const p = c.sendIntent('x', {});
    lastSocket().serverClose(1006);

    await expect(p).rejects.toThrow(/closed/i);
  });

  it('reconnects on unexpected close and fires onStatus reconnecting', async () => {
    makeClient();
    expect(createdSockets).toHaveLength(1);
    lastSocket().open();
    expect(statuses).toContain('open');

    lastSocket().serverClose(1006);

    // The reconnect scheduling path should create a second socket.
    await vi.waitFor(() => expect(createdSockets.length).toBeGreaterThanOrEqual(2), {
      timeout: 1000,
    });
    expect(statuses).toContain('reconnecting');
  });

  it('stops reconnecting after close() is called', async () => {
    const c = makeClient();
    lastSocket().open();
    const socketCountAfterOpen = createdSockets.length;

    c.close();

    // Wait a tick to ensure no new sockets are spawned.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(createdSockets.length).toBe(socketCountAfterOpen);
  });
});
