import type { Pool } from '../db.js';

export interface ValidSession { readonly userId: string; readonly email: string; }

/** How often the session reaper runs in the production boot path. */
export const SESSION_REAP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export async function createSession(
  pool: Pool, userId: string, tokenHash: Buffer, expiresAt: Date,
): Promise<void> {
  await pool.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt],
  );
}

export async function findValidSession(
  pool: Pool, tokenHash: Buffer, now: Date,
): Promise<ValidSession | null> {
  const res = await pool.query<{ userId: string; email: string }>(
    `UPDATE sessions s SET last_seen_at = $2
       FROM users u
      WHERE s.token_hash = $1
        AND s.user_id = u.id
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
     RETURNING u.id AS "userId", u.email AS email`,
    [tokenHash, now],
  );
  return res.rows[0] ?? null;
}

export async function revokeSession(pool: Pool, tokenHash: Buffer, now: Date): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash, now],
  );
}

/** Delete expired sessions and revoked sessions older than 7 days. Returns the
 *  number of rows removed. */
export async function reapSessions(pool: Pool): Promise<number> {
  const res = await pool.query(
    `DELETE FROM sessions
      WHERE expires_at < now()
         OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
  );
  return res.rowCount ?? 0;
}
