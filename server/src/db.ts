import pg from 'pg';

export type Pool = pg.Pool;

/** Anything that can run a parameterized query: the pool itself or a
 *  transaction-scoped client. Persistence helpers accept this so the same
 *  load/save code runs both pooled (auto-commit) and inside a tx. */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

/**
 * Run `fn` inside a single transaction that first takes a per-account
 * transaction-scoped advisory lock (`pg_advisory_xact_lock(hashtext(userId))`).
 *
 * The lock serializes the WHOLE load->apply->persist sequence for one account
 * across connections (two browser tabs / a tick racing an intent): a second
 * caller for the same account blocks at the lock until the first transaction
 * commits, so neither reads stale state nor clobbers the other's write. The
 * lock is released automatically when the transaction ends (commit OR rollback),
 * so a thrown `fn` both rolls back the tx (no partial persist) and frees the
 * lock. Different accounts hash to (almost always) different keys and never
 * block each other.
 */
export async function withAccountTx<T>(
  pool: pg.Pool,
  userId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
