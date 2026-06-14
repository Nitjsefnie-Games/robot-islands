import type { Pool } from '../db.js';

export interface ValidSession { readonly userId: string; readonly email: string; }

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
