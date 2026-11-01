import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Storage } from './storage/index.js';
import type { Mailer } from './mail.js';
import type { EventBus } from './realtime.js';
import type { SecretBox } from './crypto.js';

export interface AppContext {
  cfg: Config;
  db: pg.Pool;
  storage: Storage;
  mailer: Mailer;
  bus: EventBus;
  secrets: SecretBox;
  log: FastifyBaseLogger;
}

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  emailVerified: boolean;
  prefs: Record<string, unknown>;
  hasAvatar: boolean;
  /** How the request authenticated; API tokens skip CSRF checks. */
  via: 'session' | 'token';
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    user: AuthUser | null;
  }
}
