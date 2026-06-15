import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

interface Migration { readonly version: number; readonly name: string; readonly sql: string; }

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => {
      const m = /^(\d+)_/.exec(f);
      if (!m) throw new Error(`migration file lacks numeric prefix: ${f}`);
      return { version: Number(m[1]), name: f, sql: readFileSync(join(MIGRATIONS_DIR, f), 'utf8') };
    })
    .sort((a, b) => a.version - b.version);
}

/** Fixed advisory-lock key for the migration runner. Only one boot process
 *  may run migrations at a time; concurrent boots block until the winner
 *  commits, then see that all migrations are already applied. */
const MIGRATION_LOCK_KEY = 'robot-islands:migrations';

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((row) => Number(row.version)),
    );
    for (const mig of loadMigrations()) {
      if (applied.has(mig.version)) continue;
      await client.query('SAVEPOINT migrate_sp');
      try {
        await client.query(mig.sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [mig.version]);
        await client.query('RELEASE SAVEPOINT migrate_sp');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT migrate_sp');
        throw new Error(`migration ${mig.name} failed: ${(err as Error).message}`);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}

// Allow `tsx src/migrate.ts` standalone use.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPool } = await import('./db.js');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url);
  await runMigrations(pool);
  await pool.end();
  // eslint-disable-next-line no-console
  console.log('migrations applied');
}
