import type pg from 'pg';

const LOCK_ID = 727275;

export interface MaintenanceReport {
  sessions: number;
  emailTokens: number;
  invites: number;
  notifications: number;
  presence: number;
}

/**
 * Deletes expired and obsolete rows. Safe to call from every replica: only the one holding the
 * advisory lock does the work. Returns null when another replica is already running it.
 */
export async function runMaintenance(db: pg.Pool): Promise<MaintenanceReport | null> {
  const c = await db.connect();
  try {
    const { rows } = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return null;
    try {
      const n = async (sql: string) => (await c.query(sql)).rowCount ?? 0;
      return {
        sessions: await n(`DELETE FROM sessions WHERE expires_at < now()`),
        emailTokens: await n(`DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day' OR used_at < now() - interval '1 day'`),
        invites: await n(`DELETE FROM invites WHERE (used_at IS NOT NULL AND used_at < now() - interval '30 days') OR created_at < now() - interval '90 days'`),
        notifications: await n(`DELETE FROM notifications WHERE read_at < now() - interval '180 days'`),
        presence: await n(`DELETE FROM presence WHERE last_seen < now() - interval '10 minutes'`),
      };
    } finally {
      await c.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } finally {
    c.release();
  }
}
