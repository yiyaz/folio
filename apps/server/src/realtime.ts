import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { documentAccess, can, UUID_RE } from './access.js';
import { many } from './db.js';

export type BusEvent =
  | { type: 'notification'; userId: string; notification: unknown }
  | { type: 'doc-updated'; docId: string; version: number; by: string; byName: string }
  | { type: 'presence-changed'; docId: string }
  | { type: 'comments-changed'; docId: string }
  | { type: 'tree-changed'; workspaceId: string };

const CHANNEL = 'folio_events';

/**
 * Cross-replica event bus on Postgres LISTEN/NOTIFY. Each replica keeps one
 * dedicated listening connection; events are fanned out to local websockets.
 */
export class EventBus {
  private handlers = new Set<(e: BusEvent) => void>();
  private listener: pg.Client | null = null;
  readonly replicaId = randomUUID();

  constructor(
    private pool: pg.Pool,
    private connectionString: string,
    private log: { warn: (o: object, m: string) => void },
  ) {}

  async start() {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        this.dispatch(JSON.parse(msg.payload));
      } catch {
        /* ignore malformed */
      }
    });
    client.on('error', (err) => {
      this.log.warn({ err }, 'event bus listener error; reconnecting');
      this.listener = null;
      setTimeout(() => this.start().catch(() => {}), 2000);
    });
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.listener = client;
  }

  async stop() {
    const l = this.listener;
    this.listener = null;
    if (l) await l.end().catch(() => {});
  }

  on(fn: (e: BusEvent) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  private dispatch(e: BusEvent) {
    for (const h of this.handlers) h(e);
  }

  async publish(e: BusEvent) {
    if (!this.listener) {
      this.dispatch(e);
      return;
    }
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(e)]);
  }
}

interface Conn {
  id: string;
  socket: WebSocket;
  userId: string;
  docId: string | null;
}

export async function registerRealtime(app: FastifyInstance) {
  const { db, bus, cfg } = app.ctx;
  const conns = new Map<string, Conn>();
  const allowedOrigin = new URL(cfg.PUBLIC_URL).origin;
  // the Vite dev server proxies the API from another port
  const extraOrigins = new Set(cfg.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []);

  const send = (c: Conn, msg: unknown) => {
    if (c.socket.readyState === 1) c.socket.send(JSON.stringify(msg));
  };

  const presenceFor = (docId: string) =>
    many(
      db,
      `SELECT DISTINCT u.id, u.username, u.display_name AS "displayName", (u.avatar_key IS NOT NULL) AS "hasAvatar"
       FROM presence p JOIN users u ON u.id = p.user_id
       WHERE p.document_id = $1 AND p.last_seen > now() - interval '60 seconds'
       ORDER BY u.username`,
      [docId],
    );

  bus.on(async (e) => {
    try {
      if (e.type === 'notification') {
        for (const c of conns.values()) if (c.userId === e.userId) send(c, e);
      } else if (e.type === 'presence-changed') {
        const watchers = [...conns.values()].filter((c) => c.docId === e.docId);
        if (!watchers.length) return;
        const users = await presenceFor(e.docId);
        for (const c of watchers) send(c, { type: 'presence', docId: e.docId, users });
      } else if (e.type === 'doc-updated' || e.type === 'comments-changed') {
        for (const c of conns.values()) if (c.docId === e.docId) send(c, e);
      } else if (e.type === 'tree-changed') {
        for (const c of conns.values()) send(c, e);
      }
    } catch (err) {
      app.log.warn({ err }, 'realtime dispatch failed');
    }
  });

  const leave = async (c: Conn) => {
    const docId = c.docId;
    if (!docId) return;
    c.docId = null;
    await db.query('DELETE FROM presence WHERE conn_id = $1', [c.id]);
    await bus.publish({ type: 'presence-changed', docId });
  };

  // heartbeat: keep our presence rows fresh and purge rows of dead replicas
  const timer = setInterval(async () => {
    try {
      const ids = [...conns.values()].filter((c) => c.docId).map((c) => c.id);
      if (ids.length) await db.query('UPDATE presence SET last_seen = now() WHERE conn_id = ANY($1)', [ids]);
      await db.query(`DELETE FROM presence WHERE last_seen < now() - interval '90 seconds'`);
    } catch {
      /* db hiccup; retry next tick */
    }
  }, 20_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    for (const c of conns.values()) c.socket.close();
    await db.query('DELETE FROM presence WHERE replica_id = $1', [bus.replicaId]).catch(() => {});
  });

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // Browsers always send Origin on WebSocket handshakes; reject other sites (cross-site
    // WebSocket hijacking). Non-browser clients (CLI, tests) send none and authenticate normally.
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin && !extraOrigins.has(origin)) {
      socket.close(4403, 'origin not allowed');
      return;
    }
    if (!req.user) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const conn: Conn = { id: randomUUID(), socket, userId: req.user.id, docId: null };
    conns.set(conn.id, conn);

    socket.on('message', async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        if (msg.type === 'join' && typeof msg.docId === 'string' && UUID_RE.test(msg.docId)) {
          const access = await documentAccess(db, conn.userId, msg.docId);
          if (!access || !can(access.role, 'read')) return send(conn, { type: 'error', error: 'forbidden' });
          if (conn.docId && conn.docId !== msg.docId) await leave(conn);
          await db.query(
            `INSERT INTO presence (conn_id, document_id, user_id, replica_id) VALUES ($1, $2, $3, $4)
             ON CONFLICT (conn_id) DO UPDATE SET document_id = EXCLUDED.document_id, last_seen = now()`,
            [conn.id, msg.docId, conn.userId, bus.replicaId],
          );
          // only start receiving this document's presence once our own row exists, so a
          // presence list sent to us always includes us
          conn.docId = msg.docId;
          await bus.publish({ type: 'presence-changed', docId: msg.docId });
        } else if (msg.type === 'leave') {
          await leave(conn);
        } else if (msg.type === 'ping') {
          send(conn, { type: 'pong' });
        }
      } catch (err) {
        app.log.warn({ err }, 'ws message failed');
      }
    });

    socket.on('close', () => {
      conns.delete(conn.id);
      leave(conn).catch(() => {});
    });
  });
}
