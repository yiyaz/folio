import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createPool } from './db.js';
import { createStorage, type Storage } from './storage/index.js';
import { createMailer, type Mailer } from './mail.js';
import { EventBus, registerRealtime } from './realtime.js';
import { SecretBox } from './crypto/tokens.js';
import { HttpError } from './errors.js';
import { NotFoundInStorage } from './storage/index.js';
import { registerAuth } from './auth/plugin.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerUserRoutes } from './routes/users.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerDocumentRoutes } from './routes/documents.js';
import { registerAttachmentRoutes } from './routes/attachments.js';
import { embedPatterns, registerEmbedRoutes } from './routes/embeds.js';
import { registerGitRoutes } from './routes/git.js';
import { registerAiRoutes } from './routes/ai.js';
import { registerMetrics } from './metrics.js';
import { migrate } from './migrate.js';
import { runMaintenance } from './services/maintenance.js';
import { createKeyProvider, KeyError, type KeyProvider } from './crypto/keys.js';
import { reconcileAllLibraries } from './services/library.js';
import { createProvider, type LlmProvider } from './ai/provider.js';

export interface BuildOptions {
  storage?: Storage;
  mailer?: Mailer;
  fetchImpl?: typeof fetch;
  keys?: KeyProvider;
  /** Override the language model (tests); null disables AI. */
  ai?: LlmProvider | null;
  runMigrations?: boolean;
  logger?: boolean | object;
}

declare module 'fastify' {
  interface FastifyInstance {
    startDraining: () => void;
  }
}

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: cfg.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: cfg.TRUST_PROXY.trim() || false,
    // reject absurdly long requests early instead of tying up a worker
    requestTimeout: 120_000,
    bodyLimit: 2 * 1024 * 1024,
  });

  const db = createPool(cfg, app.log);
  if (opts.runMigrations) await migrate(db, (m) => app.log.info(m));
  const bus = new EventBus(db, cfg.DATABASE_URL, app.log);
  await bus.start();
  const ctx: AppContext = {
    cfg,
    db,
    storage: opts.storage ?? createStorage(cfg),
    mailer: opts.mailer ?? createMailer(cfg, app.log),
    bus,
    secrets: new SecretBox(cfg.APP_SECRET),
    keys: opts.keys ?? createKeyProvider(cfg),
    ai: opts.ai !== undefined ? opts.ai : createProvider(cfg),
    log: app.log,
  };
  app.decorate('ctx', ctx);
  app.log.info({ storage: ctx.storage.locate(''), library: cfg.LIBRARY_ENABLED, keys: ctx.keys.describe() }, 'storage and key configuration');

  const maintenance = setInterval(() => {
    runMaintenance(db)
      .then((r) => r && app.log.info({ maintenance: r }, 'maintenance completed'))
      .then(() => reconcileAllLibraries(ctx))
      .then((n) => n && app.log.info({ workspaces: n }, 'library reconciled'))
      .catch((err) => app.log.warn({ err }, 'maintenance failed'));
  }, cfg.MAINTENANCE_INTERVAL_MINUTES * 60_000);
  maintenance.unref();

  let shuttingDown = false;
  app.decorate('startDraining', () => {
    shuttingDown = true;
  });
  app.addHook('onClose', async () => {
    shuttingDown = true;
    clearInterval(maintenance);
    await bus.stop();
    await db.end();
  });

  const pyodideOrigin = new URL(cfg.PYODIDE_URL).origin;
  const plantumlOrigin = cfg.PLANTUML_SERVER ? new URL(cfg.PLANTUML_SERVER).origin : null;
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'wasm-unsafe-eval'", pyodideOrigin],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:', pyodideOrigin],
        workerSrc: ["'self'", 'blob:'],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        ...(plantumlOrigin ? { imgSrc: ["'self'", 'data:', 'blob:', 'https:', plantumlOrigin] } : {}),
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie, { secret: cfg.APP_SECRET });
  await app.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024 } });
  await app.register(rateLimit, { global: false });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: 'validation', message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof KeyError) {
      // a decryption/integrity failure: never leak details, but make it loud in the logs
      req.log.error({ err }, 'encrypted content could not be decrypted or failed its integrity check');
      return reply.code(500).send({ error: 'integrity', message: 'This content could not be decrypted' });
    }
    if (err instanceof NotFoundInStorage) {
      req.log.error({ err }, 'blob missing from storage');
      return reply.code(500).send({ error: 'storage', message: 'Stored file is missing' });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  // ---- health ----
  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    if (shuttingDown) return reply.code(503).send({ ok: false, reason: 'shutting down' });
    try {
      await db.query('SELECT 1');
      await ctx.storage.ping();
      return { ok: true };
    } catch (err: any) {
      return reply.code(503).send({ ok: false, reason: err.message });
    }
  });
  registerMetrics(app);

  app.get('/api/client-config', async () => ({
    plantumlServer: cfg.PLANTUML_SERVER || null,
    pyodideUrl: cfg.PYODIDE_URL,
    embedPatterns: embedPatterns(cfg),
    ai: !!ctx.ai,
    maxUploadMb: cfg.MAX_UPLOAD_MB,
  }));

  await registerAuth(app);
  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerDocumentRoutes(app);
  await registerAttachmentRoutes(app);
  await registerEmbedRoutes(app, opts.fetchImpl);
  await registerGitRoutes(app);
  await registerAiRoutes(app);
  await registerRealtime(app);

  // ---- SPA ----
  const webDist = cfg.WEB_DIST ? path.resolve(cfg.WEB_DIST) : null;
  if (webDist && existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      // hashed build assets never change; everything else is revalidated
      cacheControl: false,
      setHeaders: (res: any, p: string) =>
        res.header('cache-control', p.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.method !== 'GET') return reply.code(404).send({ error: 'not_found', message: 'Not found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found' }));
  }

  return app;
}
