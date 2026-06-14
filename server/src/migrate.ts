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

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations')).rows.map((row) => Number(row.version)),
  );
  for (const mig of loadMigrations()) {
    if (applied.has(mig.version)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(mig.sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [mig.version]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${mig.name} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
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
