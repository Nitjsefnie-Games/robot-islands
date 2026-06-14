export interface Config {
  readonly databaseUrl: string;
  readonly port: number;
  readonly cookieSecure: boolean;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const port = env.PORT ? Number(env.PORT) : 5180;
  if (!Number.isInteger(port) || port <= 0) throw new Error(`invalid PORT: ${env.PORT}`);
  const cookieSecure = env.COOKIE_SECURE !== '0';
  return { databaseUrl, port, cookieSecure };
}

/** Guard: refuse to run destructive test setup against a non-test database. */
export function assertTestDatabase(databaseUrl: string): void {
  // Match the database name (last path segment, before any query string).
  const name = databaseUrl.split('/').pop()?.split('?')[0] ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to use non-test database "${name}" (must end in _test)`);
  }
}
