import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
