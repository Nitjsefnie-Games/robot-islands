import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildApp } from './app.js';

async function start(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const app = buildApp({ pool, cookieSecure: config.cookieSecure });
  await app.listen({ host: '127.0.0.1', port: config.port });
  // eslint-disable-next-line no-console
  console.log(`robot-islands auth server listening on 127.0.0.1:${config.port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('server failed to start:', err);
  process.exit(1);
});
