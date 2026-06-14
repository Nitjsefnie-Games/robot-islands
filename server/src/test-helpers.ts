import { createPool, type Pool } from './db.js';
import { assertTestDatabase } from './config.js';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';

const URL = process.env.DATABASE_URL ?? 'postgresql:///robot_islands_test';

export function testPool(): Pool {
  assertTestDatabase(URL);
  return createPool(URL);
}

export async function resetDb(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE sessions, users RESTART IDENTITY CASCADE');
}

export function buildTestApp(pool: Pool): FastifyInstance {
  return buildApp({ pool, cookieSecure: false });
}
