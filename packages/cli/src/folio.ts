import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Api, extractZip, loadConfig, parseArgs, saveConfig, zipMarkdownDir } from './lib.js';

const HELP = `folio - command-line client for Folio

Usage:
  folio login --url <server> --token <token>   Save credentials (token from Settings → API tokens)
  folio whoami                                 Show the current user
  folio workspaces                             List workspaces (id, role, name)
  folio pull <workspace-id> [dir]              Download all documents as Markdown into dir (default: .)
  folio push <dir> --workspace <id> [--folder <id>]
                                               Upload Markdown files; files with an "id" in front matter
                                               update their document, others are created
  folio search <query> [--workspace <id>]      Full-text search
  folio cat <document-id>                      Print a document's Markdown
  folio generate <workspace-id> "<prompt>" [--name <doc name>] [--folder <id>]
               [--context <doc-id,doc-id>] [--context-folder <id>] [--context-workspace]
               [--append <doc-id>] [--print]
                                               Write a document with the workspace's AI, grounded in
                                               the given documents; --print only prints the text
  folio new <workspace-id> <name> [--file f] [--folder <id>]
                                               Create a document from a file or stdin (e.g. CI reports)

Environment: FOLIO_URL and FOLIO_TOKEN override the saved configuration.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv: string[]) {
  const { _, flags } = parseArgs(argv);
  const [cmd, ...args] = _;
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);

  if (cmd === 'login') {
    const url = String(flags.url ?? '').replace(/\/$/, '');
    const token = String(flags.token ?? '');
    if (!url || !token) throw new Error('usage: folio login --url <server> --token <token>');
    const me = await new Api({ url, token }).json('GET', '/api/auth/me');
    await saveConfig({ url, token });
    return console.log(`Logged in to ${url} as @${me.user.username}`);
  }

  const api = new Api(await loadConfig());
  switch (cmd) {
    case 'whoami': {
      const me = await api.json('GET', '/api/auth/me');
      return console.log(`@${me.user.username} (${me.user.displayName}) <${me.user.email}>`);
    }
    case 'workspaces': {
      for (const w of await api.json<any[]>('GET', '/api/workspaces')) console.log(`${w.id}\t${w.role}\t${w.name}`);
      return;
    }
    case 'pull': {
      const [ws, dir = '.'] = args;
      if (!ws) throw new Error('usage: folio pull <workspace-id> [dir]');
      const res = await api.request('GET', `/api/workspaces/${ws}/export`);
      const files = await extractZip(await res.arrayBuffer(), dir);
      return console.log(`Pulled ${files.length} file(s) into ${path.resolve(dir)}`);
    }
    case 'push': {
      const [dir] = args;
      const ws = flags.workspace;
      if (!dir || typeof ws !== 'string') throw new Error('usage: folio push <dir> --workspace <id> [--folder <id>]');
      const { buffer, files } = await zipMarkdownDir(dir);
      if (!files.length) throw new Error(`no Markdown files found in ${dir}`);
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(buffer)], { type: 'application/zip' }), 'push.zip');
      const q = typeof flags.folder === 'string' ? `?folderId=${flags.folder}` : '';
      const res = await api.request('POST', `/api/workspaces/${ws}/import${q}`, form);
      const r = (await res.json()) as { created: number; updated: number; unchanged: number; skipped: string[] };
      return console.log(
        `Pushed ${files.length} file(s): ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`,
      );
    }
    case 'search': {
      const q = args.join(' ');
      if (!q) throw new Error('usage: folio search <query>');
      const ws = typeof flags.workspace === 'string' ? `&workspaceId=${flags.workspace}` : '';
      const hits = await api.json<any[]>('GET', `/api/search?q=${encodeURIComponent(q)}${ws}`);
      for (const h of hits) console.log(`${h.id}\t${h.workspaceName}\t${h.title}`);
      if (!hits.length) console.error('no results');
      return;
    }
    case 'cat': {
      const [id] = args;
      if (!id) throw new Error('usage: folio cat <document-id>');
      const d = await api.json('GET', `/api/documents/${id}`);
      return process.stdout.write(d.content);
    }
    case 'new': {
      const [ws, ...nameParts] = args;
      const name = nameParts.join(' ');
      if (!ws || !name) throw new Error('usage: folio new <workspace-id> <name> [--file path]');
      const content = typeof flags.file === 'string' ? await fs.readFile(flags.file, 'utf8') : await readStdin();
      const d = await api.json('POST', '/api/documents', {
        workspaceId: ws,
        name,
        content: content || `# ${name}\n`,
        folderId: typeof flags.folder === 'string' ? flags.folder : null,
      });
      return console.log(`${d.id}\t${d.name}`);
    }
    case 'generate': {
      const [ws, ...promptParts] = args;
      const prompt = promptParts.join(' ').trim();
      if (!ws || !prompt) throw new Error('usage: folio generate <workspace-id> "<prompt>" [options]');
      const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined);
      const context = {
        documentIds: str('context')
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        folderId: str('context-folder'),
        workspace: flags['context-workspace'] === true || undefined,
      };
      const target = flags.print
        ? { type: 'text' }
        : str('append')
          ? { type: 'append', documentId: str('append') }
          : { type: 'new', name: str('name'), folderId: str('folder') ?? null };
      const r = await api.json('POST', '/api/ai/generate', { prompt, workspaceId: ws, context, target });
      for (const o of r.context.omitted) console.error(`note: ${o.name ?? 'a document'} was not shared with the AI (${o.reason})`);
      if (flags.print) return process.stdout.write(r.text);
      return console.log(`${r.document.id}\t${r.document.name}\t(${r.context.used.length} context document(s), model ${r.model})`);
    }
    default:
      throw new Error(`unknown command "${cmd}". Run "folio help".`);
  }
}

const isEntry = process.argv[1] && /folio(\.[jt]s)?$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
