import pg from 'pg';
import type { Config } from './config.js';

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(cfg: Config, log?: { error: (o: object, m: string) => void }): pg.Pool {
  const pool = new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // a runaway query must not hold a connection (and a row lock) forever
    statement_timeout: 30_000,
    application_name: 'folio',
  });
  // An idle client losing its connection (DB restart, failover) emits 'error' on the pool;
  // unhandled, that would crash the process. The pool replaces the client on next use.
  pool.on('error', (err) => (log ? log.error({ err }, 'idle database client error') : console.error('idle database client error', err)));
  return pool;
}

export async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}
