export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly cookieSecure: boolean;
  readonly allowedWsOrigins: ReadonlyArray<string>;
}

/** Default Origins allowed to open the authenticated intent WebSocket. Browsers
 *  always send `Origin` on WS upgrades; checking it closes Cross-Site WebSocket
 *  Hijacking (CSWSH). Override with the comma-separated `ALLOWED_WS_ORIGINS`
 *  env var. */
export const DEFAULT_ALLOWED_WS_ORIGINS: ReadonlyArray<string> = [
  'https://islands.nitjsefni.eu',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = env.PORT ? Number(env.PORT) : 5180;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT: ${env.PORT}`);
  const cookieSecure = env.COOKIE_SECURE !== '0';
  const allowedWsOrigins = env.ALLOWED_WS_ORIGINS
    ? env.ALLOWED_WS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_WS_ORIGINS;
  return { databaseUrl, port, cookieSecure, allowedWsOrigins };
}

/** Guard: refuse to run destructive test setup against a non-test database. */
export function assertTestDatabase(databaseUrl: string): void {
  // Match the database name (last path segment, before any query string).
  const name = databaseUrl.split('/').pop()?.split('?')[0] ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to use non-test database "${name}" (must end in _test)`);
  }
}
