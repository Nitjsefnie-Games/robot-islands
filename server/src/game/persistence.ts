// server/src/game/persistence.ts
import type { Queryable } from '../db.js';
import type { SaveSnapshot } from '../../../src/persistence.js';

export async function hasSave(db: Queryable, userId: string): Promise<boolean> {
  const res = await db.query('SELECT 1 FROM saves WHERE user_id = $1', [userId]);
  return (res.rowCount ?? 0) > 0;
}

export async function loadSnapshot(db: Queryable, userId: string): Promise<SaveSnapshot | null> {
  const res = await db.query<{ snapshot: SaveSnapshot }>(
    'SELECT snapshot FROM saves WHERE user_id = $1',
    [userId],
  );
  return res.rows[0]?.snapshot ?? null;
}

export async function saveSnapshot(db: Queryable, userId: string, snapshot: SaveSnapshot): Promise<void> {
  await db.query(
    `INSERT INTO saves (user_id, snapshot, schema_version, updated_at)
       -- schema_version: denormalized from snapshot.v for cheap version
       -- queries / future bulk migration; the loader reads snapshot.v itself.
       VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot,
           schema_version = EXCLUDED.schema_version,
           updated_at = now()`,
    [userId, snapshot, snapshot.v],
  );
}
