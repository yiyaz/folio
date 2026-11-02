import type pg from 'pg';
import init001 from './migrations/001_init.js';
import library002 from './migrations/002_library.js';
import restricted003 from './migrations/003_restricted.js';

/** Ordered list of migrations. Never edit a shipped migration; append a new one. */
export const MIGRATIONS: { id: string; sql: string }[] = [
  { id: '001_init', sql: init001 },
  { id: '002_library', sql: library002 },
  { id: '003_restricted', sql: restricted003 },
];

export async function migrate(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // advisory lock so concurrent replicas / the migration Job don't race
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log(`applying migration ${m.id}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
  return applied;
}
