import { applySnapshotDelta, type SnapshotDelta } from './snapshot-delta.js';
import type { SaveSnapshot } from './persistence.js';

export type Ack =
  | { seq: number; ok: true }
  | { seq: number; ok: false; error: string };

export interface GameServerClient {
  sendIntent(type: string, payload: unknown): Promise<Ack>;
  close(): void;
}

interface PendingIntent {
  resolve: (ack: Ack) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectGameServerOptions {
  url: string;
  onState: (snapshot: unknown | null) => void;
  onStatus?: (status: 'open' | 'closed' | 'reconnecting') => void;
  WebSocketCtor?: typeof WebSocket;
}

const INTENT_TIMEOUT_MS = 10_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const BACKOFF_MULTIPLIER = 2;

function isAck(value: unknown): value is Ack {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.seq !== 'number') return false;
  if (v.ok === true) return true;
  if (v.ok === false && typeof v.error === 'string') return true;
  return false;
}

function isStateFrame(value: unknown): value is { type: 'state'; snapshot: unknown | null } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'state' && 'snapshot' in v;
}

function isStateDeltaFrame(value: unknown): value is { type: 'state-delta'; delta: SnapshotDelta } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'state-delta' && typeof v.delta === 'object' && v.delta !== null;
}

export function gameSocketUrl(): string {
  const protocol = globalThis.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${globalThis.location.host}/api/game/ws`;
}

export function connectGameServer(opts: ConnectGameServerOptions): GameServerClient {
  const WebSocketCtor = opts.WebSocketCtor ?? globalThis.WebSocket;
  const url = opts.url;
  const onState = opts.onState;
  const onStatus = opts.onStatus;

  let socket: WebSocket | null = null;
  let closed = false;
  let seq = 0;
  const pending = new Map<number, PendingIntent>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  // The last full snapshot delivered to `onState`. The server sends a full
  // `state` frame as the per-socket baseline, then `state-delta` frames that
  // patch it; we reconstruct the full snapshot here so `onState` always sees a
  // complete SaveSnapshot. Reset on (re)connect so the next baseline reseeds.
  let lastSnapshot: SaveSnapshot | null = null;

  function cleanupSocket(): void {
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Ignore errors from closing an already-closing socket.
    }
    socket = null;
  }

  function rejectAllPending(reason: string): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  }

  function scheduleReconnect(): void {
    if (closed) return;
    onStatus?.('reconnecting');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) connect();
    }, backoffMs);
    backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  function onMessage(ev: MessageEvent): void {
    let frame: unknown;
    try {
      frame = JSON.parse(String(ev.data));
    } catch {
      // Malformed frame: ignore silently.
      return;
    }

    if (isAck(frame)) {
      const p = pending.get(frame.seq);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(frame.seq);
      p.resolve(frame);
      return;
    }

    if (isStateFrame(frame)) {
      // A full baseline snapshot (or null when the account has no game yet).
      lastSnapshot = (frame.snapshot ?? null) as SaveSnapshot | null;
      onState(frame.snapshot);
      return;
    }

    if (isStateDeltaFrame(frame)) {
      // A delta is only meaningful against a prior baseline. The server
      // guarantees a full `state` frame first on every socket, and we reset
      // `lastSnapshot` on (re)connect, so a delta without a base is a protocol
      // desync — drop it and wait for the next baseline rather than corrupt state.
      if (lastSnapshot === null) return;
      lastSnapshot = applySnapshotDelta(lastSnapshot, frame.delta);
      onState(lastSnapshot);
    }
  }

  function connect(): void {
    if (closed || socket) return;
    // A new socket gets a fresh full baseline from the server; discard any
    // prior snapshot so a stale base can't be patched by the new socket's deltas.
    lastSnapshot = null;
    try {
      socket = new WebSocketCtor(url);
    } catch (err) {
      onStatus?.('closed');
      scheduleReconnect();
      return;
    }

    socket.addEventListener('open', () => {
      backoffMs = INITIAL_BACKOFF_MS;
      onStatus?.('open');
    });

    socket.addEventListener('message', onMessage);

    socket.addEventListener('close', () => {
      onStatus?.('closed');
      rejectAllPending('Socket closed before ack');
      socket = null;
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // Errors are followed by a close event; handle cleanup there.
    });
  }

  connect();

  return {
    sendIntent(type: string, payload: unknown): Promise<Ack> {
      if (closed) {
        return Promise.reject(new Error('Client is closed'));
      }
      if (!socket || socket.readyState !== WebSocketCtor.OPEN) {
        return Promise.reject(new Error('Socket is not open'));
      }

      const mySeq = ++seq;
      return new Promise<Ack>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(mySeq);
          reject(new Error(`Intent ${mySeq} timed out`));
        }, INTENT_TIMEOUT_MS);

        pending.set(mySeq, { resolve, reject, timer });

        try {
          socket!.send(JSON.stringify({ type, payload, seq: mySeq }));
        } catch (err) {
          clearTimeout(timer);
          pending.delete(mySeq);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectAllPending('Client closed');
      cleanupSocket();
      onStatus?.('closed');
    },
  };
}
