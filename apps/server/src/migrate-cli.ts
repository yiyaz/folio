import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';

/** Runs pending migrations; waits up to MIGRATE_WAIT_SECONDS for the database to come up. */
const cfg = loadConfig();
const pool = createPool(cfg);
const deadline = Date.now() + Number(process.env.MIGRATE_WAIT_SECONDS ?? 90) * 1000;

async function run() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e: any) {
      if (Date.now() > deadline) throw e;
      console.log(`database not ready (${e.code ?? e.message}), retrying… [${attempt}]`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const applied = await migrate(pool, (m) => console.log(m));
  console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date');
}

run()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
