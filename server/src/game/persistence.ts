// server/src/game/persistence.ts
import type { Pool } from '../db.js';
import type { SaveSnapshot } from '../../../src/persistence.js';

export async function hasSave(pool: Pool, userId: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM saves WHERE user_id = $1', [userId]);
  return (res.rowCount ?? 0) > 0;
}

export async function loadSnapshot(pool: Pool, userId: string): Promise<SaveSnapshot | null> {
  const res = await pool.query<{ snapshot: SaveSnapshot }>(
    'SELECT snapshot FROM saves WHERE user_id = $1',
    [userId],
  );
  return res.rows[0]?.snapshot ?? null;
}

export async function saveSnapshot(pool: Pool, userId: string, snapshot: SaveSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO saves (user_id, snapshot, schema_version, updated_at)
       VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           schema_version = EXCLUDED.schema_version,
           updated_at = now()`,
    [userId, snapshot, snapshot.v],
  );
}
