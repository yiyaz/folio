import type { AppContext } from '../context.js';
import { one } from '../db.js';

export interface SignupSettings {
  mode: 'open' | 'invite' | 'domain' | 'closed';
  allowedDomains: string[];
}

/** Admin-editable settings stored in the DB take precedence over env defaults. */
export async function getSignupSettings(ctx: AppContext): Promise<SignupSettings> {
  const row = await one<{ value: SignupSettings }>(ctx.db, `SELECT value FROM app_settings WHERE key = 'signup'`);
  return (
    row?.value ?? {
      mode: ctx.cfg.SIGNUP_MODE,
      allowedDomains: ctx.cfg.SIGNUP_ALLOWED_DOMAINS.split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    }
  );
}

export async function setSignupSettings(ctx: AppContext, s: SignupSettings) {
  await ctx.db.query(`INSERT INTO app_settings (key, value) VALUES ('signup', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [s]);
}
