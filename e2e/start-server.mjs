// Prepares a fresh database, storage dir and mailbox, then starts the built server.
import pg from 'pg';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = new URL(process.env.DATABASE_URL);
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const c = new pg.Client({ connectionString: adminUrl.toString() });
await c.connect();
const db = url.pathname.slice(1);
await c.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await c.query(`CREATE DATABASE ${db}`);
await c.end();
rmSync(path.join(root, '.data/e2e-storage'), { recursive: true, force: true });
rmSync(path.join(root, '.mail/e2e'), { recursive: true, force: true });
await import(path.join(root, 'apps/server/dist/main.js'));
