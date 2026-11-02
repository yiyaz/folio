import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v == null || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('postgres://folio:folio@localhost:5432/folio'),
  DATABASE_POOL_MAX: z.coerce.number().default(10),
  /** 32+ chars; used to encrypt stored secrets (git tokens). */
  APP_SECRET: z.string().min(16).default('dev-insecure-secret-change-me-please'),

  STORAGE_DRIVER: z.enum(['fs', 's3']).default('fs'),
  STORAGE_FS_ROOT: z.string().default('./.data/storage'),
  /** Optional key prefix (e.g. "folio/prod") so several deployments can share one bucket. */
  STORAGE_PREFIX: z.string().default(''),
  /** Maintain the human-readable library/ mirror of every workspace. */
  LIBRARY_ENABLED: bool(true),
  S3_BUCKET: z.string().default('folio'),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(true),

  /** smtp://user:pass@host:port, "log" (print to stdout) or "file:/dir" (write JSON, for tests). */
  MAIL_TRANSPORT: z.string().default('log'),
  MAIL_FROM: z.string().default('Folio <no-reply@folio.local>'),

  SIGNUP_MODE: z.enum(['open', 'invite', 'domain', 'closed']).default('open'),
  SIGNUP_ALLOWED_DOMAINS: z.string().default(''),
  REQUIRE_EMAIL_VERIFICATION: bool(true),
  SESSION_TTL_DAYS: z.coerce.number().default(30),
  /** Defaults to true when PUBLIC_URL is https. */
  COOKIE_SECURE: z.string().optional(),
  /**
   * Reverse proxies whose X-Forwarded-For header is trusted for the client IP (used for rate
   * limiting and logs): comma-separated addresses/CIDRs or the keywords loopback, linklocal,
   * uniquelocal. Empty = trust nobody; otherwise clients could spoof their IP.
   */
  TRUST_PROXY: z.string().default(''),
  MAINTENANCE_INTERVAL_MINUTES: z.coerce.number().min(1).default(60),

  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().default(10),
  MAX_UPLOAD_MB: z.coerce.number().default(25),

  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_NAME: z.string().default('Single sign-on'),

  WEB_DIST: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_API_URL: z.string().default('https://api.github.com'),
  JIRA_BASE_URL: z.string().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_TOKEN: z.string().optional(),
  GIT_ALLOW_FILE_REMOTES: bool(false),

  PLANTUML_SERVER: z.string().default(''),
  PYODIDE_URL: z.string().default('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/'),

  /** Key-encryption keys for restricted documents: "local" (FOLIO_KEYS / derived) or "vault". */
  KEY_PROVIDER: z.enum(['local', 'vault']).default('local'),
  FOLIO_KEYS: z.string().default(''),
  VAULT_ADDR: z.string().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_TRANSIT_KEY: z.string().default('folio'),

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  /** "anthropic" (needs ANTHROPIC_API_KEY) or "fake" (deterministic, for tests and demos; never in production). */
  AI_PROVIDER: z.enum(['anthropic', 'fake']).optional(),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  /** Upper bound for workspace documents sent as context (characters, roughly 4 per token). */
  AI_CONTEXT_MAX_CHARS: z.coerce.number().int().min(1000).default(400_000),
});

export type Config = Omit<z.infer<typeof schema>, 'COOKIE_SECURE'> & { COOKIE_SECURE: boolean };

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.parse(env);
  const cookieSecure =
    parsed.COOKIE_SECURE == null || parsed.COOKIE_SECURE === ''
      ? parsed.PUBLIC_URL.startsWith('https://')
      : ['1', 'true', 'yes', 'on'].includes(parsed.COOKIE_SECURE.toLowerCase());
  const cfg: Config = { ...parsed, COOKIE_SECURE: cookieSecure };
  if (cfg.NODE_ENV === 'production') {
    if (cfg.APP_SECRET.startsWith('dev-insecure') || cfg.APP_SECRET.length < 32)
      throw new Error('APP_SECRET must be set to at least 32 random characters in production');
    if (cfg.PUBLIC_URL.startsWith('https://') && !cfg.COOKIE_SECURE) throw new Error('COOKIE_SECURE must not be disabled when PUBLIC_URL is https');
  }
  try {
    new URL(cfg.PUBLIC_URL);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${cfg.PUBLIC_URL}`);
  }
  return cfg;
}
