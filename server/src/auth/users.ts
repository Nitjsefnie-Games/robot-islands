import type { Pool } from '../db.js';

export interface PublicUser { readonly id: string; readonly email: string; }
export interface UserWithSecret extends PublicUser { readonly password: string; }

export class EmailTakenError extends Error {
  constructor() { super('email already registered'); this.name = 'EmailTakenError'; }
}

export async function createUser(pool: Pool, email: string, passwordHash: string): Promise<PublicUser> {
  try {
    const res = await pool.query<PublicUser>(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash],
    );
    return res.rows[0]!; // INSERT...RETURNING always yields exactly one row
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      throw new EmailTakenError();
    }
    throw err;
  }
}

export async function findByEmail(pool: Pool, email: string): Promise<UserWithSecret | null> {
  const res = await pool.query<UserWithSecret>(
    'SELECT id, email, password FROM users WHERE email = $1',
    [email],
  );
  return res.rows[0] ?? null;
}

export async function findById(pool: Pool, id: string): Promise<PublicUser | null> {
  const res = await pool.query<PublicUser>('SELECT id, email FROM users WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}
