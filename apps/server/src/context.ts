import type pg from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config.js';
import type { Storage } from './storage/index.js';
import type { Mailer } from './mail.js';
import type { EventBus } from './realtime.js';
import type { SecretBox } from './crypto/tokens.js';
import type { KeyProvider } from './crypto/keys.js';
import type { LlmProvider } from './ai/provider.js';

export interface AppContext {
  cfg: Config;
  db: pg.Pool;
  storage: Storage;
  mailer: Mailer;
  bus: EventBus;
  secrets: SecretBox;
  keys: KeyProvider;
  /** Language model for AI features, or null when AI is not configured. */
  ai: LlmProvider | null;
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
