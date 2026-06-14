import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { assertTestDatabase } from './config.js';

export default async function globalSetup(): Promise<void> {
  const url = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';
  assertTestDatabase(url);
  const pool = createPool(url);
  await runMigrations(pool);
  await pool.end();
}
