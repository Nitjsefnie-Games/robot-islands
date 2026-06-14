export type Ack =
  | { seq: number; ok: true; projection?: unknown }
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
      onState(frame.snapshot);
    }
  }

  function connect(): void {
    if (closed || socket) return;
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
