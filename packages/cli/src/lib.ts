import JSZip from 'jszip';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CliConfig {
  url: string;
  token: string;
}

export const configPath = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'folio', 'config.json');

export async function loadConfig(): Promise<CliConfig> {
  const envUrl = process.env.FOLIO_URL;
  const envToken = process.env.FOLIO_TOKEN;
  let file: Partial<CliConfig> = {};
  try {
    file = JSON.parse(await fs.readFile(configPath(), 'utf8'));
  } catch {
    /* no config yet */
  }
  const url = (envUrl ?? file.url ?? '').replace(/\/$/, '');
  const token = envToken ?? file.token ?? '';
  if (!url || !token) throw new Error('Not logged in. Run: folio login --url https://folio.example.com --token <token>  (or set FOLIO_URL / FOLIO_TOKEN)');
  return { url, token };
}

export async function saveConfig(cfg: CliConfig) {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export class Api {
  constructor(
    private cfg: CliConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: string, p: string, body?: string | FormData, headers: Record<string, string> = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.cfg.url}${p}`, { method, body, headers: { authorization: `Bearer ${this.cfg.token}`, ...headers } });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = ((await res.json()) as { message?: string }).message ?? msg;
      } catch {
        /* not json */
      }
      throw new Error(`${method} ${p} failed (${res.status}): ${msg}`);
    }
    return res;
  }

  async json<T = any>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await this.request(
      method,
      p,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? {} : { 'content-type': 'application/json' },
    );
    return (await res.json()) as T;
  }
}

/** Extract a zip into dir, refusing entries that would escape it. Returns written paths. */
export async function extractZip(buf: ArrayBuffer | Buffer, dir: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const root = path.resolve(dir);
  const written: string[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const target = path.resolve(root, entry.name);
    if (!target.startsWith(root + path.sep)) throw new Error(`refusing to write outside ${dir}: ${entry.name}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await entry.async('nodebuffer'));
    written.push(path.relative(root, target));
  }
  return written.sort();
}

/** Zip every Markdown file below dir (skipping dot-directories and node_modules). */
export async function zipMarkdownDir(dir: string): Promise<{ buffer: Buffer; files: string[] }> {
  const zip = new JSZip();
  const files: string[] = [];
  async function walk(rel: string) {
    for (const e of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else if (/\.(md|markdown)$/i.test(e.name)) {
        zip.file(p, await fs.readFile(path.join(dir, p)));
        files.push(p);
      }
    }
  }
  await walk('');
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), files: files.sort() };
}

export function parseArgs(argv: string[]): { _: string[]; flags: Record<string, string | true> } {
  const out = { _: [] as string[], flags: {} as Record<string, string | true> };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) out.flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}
