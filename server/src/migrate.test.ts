import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';
const pool = createPool(URL);

beforeAll(async () => {
  await pool.query('DROP TABLE IF EXISTS sessions, users, schema_migrations CASCADE');
});
afterAll(async () => { await pool.end(); });

describe('runMigrations', () => {
  it('creates schema_migrations and applies 0001', async () => {
    await runMigrations(pool);
    const v = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(v.rows.map((r) => r.version)).toContain(1);
    const t = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('users','sessions')",
    );
    expect(t.rows.length).toBe(2);
  });

  it('is idempotent (second run is a no-op)', async () => {
    await runMigrations(pool);
    const v = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(v.rows[0].n).toBe(3);
  });

  it('0003 shards saves into save_meta/save_world/save_islands and drops saves', async () => {
    const present = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('save_meta','save_world','save_islands','saves')`,
    );
    const names = present.rows.map((r) => r.table_name).sort();
    expect(names).toEqual(['save_islands', 'save_meta', 'save_world']);
  });
});
