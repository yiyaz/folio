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
  COOKIE_SECURE: bool(false),

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

  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = schema.parse(env);
  if (cfg.NODE_ENV === 'production' && cfg.APP_SECRET.startsWith('dev-insecure')) {
    throw new Error('APP_SECRET must be set in production');
  }
  return cfg;
}
