import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { loadConfig } from './config.js';
import { createPool, many } from './db.js';
import { createStorage } from './storage/index.js';
import { createKeyProvider } from './crypto/keys.js';
import { open as decryptEnvelope, parse as parseEnvelope } from './crypto/envelope.js';
import type { AppContext } from './context.js';

const HELP = `Folio administration

  node dist/admin-cli.js library:rebuild [--workspace <id>]
      Re-create the human-readable library/ folder in storage (normally kept up to date automatically).

  node dist/admin-cli.js keys:generate [--id <name>]
      Print a new random key-encryption key entry for FOLIO_KEYS.

  node dist/admin-cli.js keys:rotate
      Re-wrap every restricted document's data key with the active key (first entry of FOLIO_KEYS,
      or the Vault key). Run after adding a new key in front of FOLIO_KEYS; the old key can be
      removed once this finishes without errors.

  node dist/admin-cli.js decrypt <file.md.folio-encrypted> [--out <file.md>]
      Decrypt a restricted document taken from storage or the library (e.g. from a backup).
      Needs only the deployment's key configuration (FOLIO_KEYS / APP_SECRET or Vault), not the database.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function withContext<T>(fn: (ctx: AppContext) => Promise<T>): Promise<T> {
  const cfg = loadConfig();
  const db = createPool(cfg);
  const log = { info: console.log, warn: console.warn, error: console.error, fatal: console.error, debug: () => {}, trace: () => {}, child: () => log } as any;
  const ctx = { cfg, db, storage: createStorage(cfg), keys: createKeyProvider(cfg), log, bus: { publish: async () => {} } } as unknown as AppContext;
  try {
    return await fn(ctx);
  } finally {
    await db.end();
  }
}

export async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'library:rebuild':
      return withContext(async (ctx) => {
        const { reconcileWorkspace } = await import('./services/library.js');
        const ids = flag(args, 'workspace')
          ? [flag(args, 'workspace')!]
          : (await many<{ id: string }>(ctx.db, 'SELECT id FROM workspaces ORDER BY created_at')).map((w) => w.id);
        for (const id of ids) {
          const r = await reconcileWorkspace(ctx, id);
          console.log(`${id}: ${r.synced} file(s) written, ${r.removed} stray file(s) removed`);
        }
        console.log(`library: ${ctx.storage.locate('library/')}`);
      });
    case 'keys:generate': {
      const id = flag(args, 'id') ?? `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
      console.log(`${id}:${randomBytes(32).toString('base64')}`);
      console.error('\nPut this entry FIRST in FOLIO_KEYS (comma-separated, keep the old keys after it), restart, then run keys:rotate.');
      return;
    }
    case 'keys:rotate':
      return withContext(async (ctx) => {
        const { rewrapDocument } = await import('./services/documents.js');
        const docs = await many<{ id: string }>(ctx.db, `SELECT id FROM documents WHERE classification = 'restricted' AND kek_id IS DISTINCT FROM $1`, [
          ctx.keys.activeKekId,
        ]);
        let failed = 0;
        for (const d of docs) {
          try {
            await rewrapDocument(ctx, d.id);
          } catch (e) {
            failed++;
            console.error(`${d.id}: ${(e as Error).message}`);
          }
        }
        console.log(`re-wrapped ${docs.length - failed} of ${docs.length} restricted document(s) with "${ctx.keys.activeKekId}"`);
        if (failed) process.exitCode = 1;
      });
    case 'decrypt': {
      const file = args.find((a) => !a.startsWith('--') && a !== flag(args, 'out'));
      if (!file) throw new Error('usage: decrypt <file> [--out <file>]');
      const cfg = loadConfig();
      const data = await fs.readFile(file);
      const env = parseEnvelope(data);
      const plain = await decryptEnvelope(data, createKeyProvider(cfg));
      const out = flag(args, 'out');
      if (out) {
        await fs.writeFile(out, plain);
        console.error(`decrypted ${env.kind} of document ${env.doc} -> ${out}`);
      } else process.stdout.write(plain);
      return;
    }
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
