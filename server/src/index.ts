import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';
import { reapSessions, SESSION_REAP_INTERVAL_MS } from './auth/sessions.js';

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const app = buildApp({ pool, cookieSecure: config.cookieSecure, allowedWsOrigins: config.allowedWsOrigins });
  await app.listen({ host: '127.0.0.1', port: config.port });
  // Periodically reap expired/revoked sessions. Guarded from tests: the interval
  // is only started here in the production boot path, never from buildApp.
  if (!process.env.VITEST) {
    setInterval(() => {
      reapSessions(pool).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('session reaper failed:', err);
      });
    }, SESSION_REAP_INTERVAL_MS);
  }
  // eslint-disable-next-line no-console
  console.log(`robot-islands auth server listening on 127.0.0.1:${config.port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('server failed to start:', err);
  process.exit(1);
});
