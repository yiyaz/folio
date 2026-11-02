import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/plugin.js';
import { badRequest } from '../errors.js';
import type { Config } from '../config.js';

export type Embed =
  | {
      kind: 'github-pr' | 'github-issue';
      url: string;
      title: string;
      number: number;
      state: string;
      repo: string;
      author: string;
      labels: string[];
      merged?: boolean;
      draft?: boolean;
    }
  | { kind: 'github-code'; url: string; repo: string; path: string; ref: string; startLine: number; endLine: number; language: string; code: string }
  | { kind: 'jira'; url: string; key: string; title: string; status: string; assignee: string | null; type: string };

const GH_ISSUE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)\/?(?:[#?].*)?$/;
const GH_BLOB = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/([^#?]+)(?:\?[^#]*)?(?:#L(\d+)(?:-L(\d+))?)?$/;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'bash',
  md: 'markdown',
  json: 'json',
  kt: 'kotlin',
  cs: 'csharp',
  cpp: 'cpp',
  c: 'c',
  scala: 'scala',
  r: 'r',
};

/** Patterns the client may turn into rich embeds; mirrors what fetchEmbed supports. */
export function embedPatterns(cfg: Config): string[] {
  const p = [GH_ISSUE.source, GH_BLOB.source];
  if (cfg.JIRA_BASE_URL) p.push(`^${cfg.JIRA_BASE_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/browse/[A-Z][A-Z0-9]+-\\d+/?$`);
  return p;
}

class TTLCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(
    private ttl: number,
    private max = 500,
  ) {}
  get(k: string) {
    const e = this.m.get(k);
    if (!e || e.exp < Date.now()) return undefined;
    return e.v;
  }
  set(k: string, v: V) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value!);
    this.m.set(k, { v, exp: Date.now() + this.ttl });
  }
}

export function createEmbedFetcher(cfg: Config, fetchImpl: typeof fetch = fetch) {
  const cache = new TTLCache<Embed | null>(10 * 60_000);

  const gh = async (path: string, accept = 'application/vnd.github+json') => {
    const r = await fetchImpl(`${cfg.GITHUB_API_URL}${path}`, {
      headers: { accept, 'user-agent': 'folio', ...(cfg.GITHUB_TOKEN ? { authorization: `Bearer ${cfg.GITHUB_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`github ${r.status}`);
    return r;
  };

  return async function fetchEmbed(url: string): Promise<Embed | null> {
    const cached = cache.get(url);
    if (cached !== undefined) return cached;
    let out: Embed | null = null;
    let m: RegExpExecArray | null;
    try {
      if ((m = GH_ISSUE.exec(url))) {
        const [, owner, repo, kind, num] = m;
        const data: any = await (await gh(`/repos/${owner}/${repo}/${kind === 'pull' ? 'pulls' : 'issues'}/${num}`)).json();
        out = {
          kind: kind === 'pull' ? 'github-pr' : 'github-issue',
          url,
          title: data.title,
          number: data.number,
          state: data.state,
          repo: `${owner}/${repo}`,
          author: data.user?.login ?? '',
          labels: (data.labels ?? []).map((l: any) => l.name),
          merged: data.merged ?? undefined,
          draft: data.draft ?? undefined,
        };
      } else if ((m = GH_BLOB.exec(url))) {
        const [, owner, repo, ref, path, l1, l2] = m;
        const text = await (await gh(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, 'application/vnd.github.raw')).text();
        const lines = text.split('\n');
        const start = l1 ? Math.max(1, Number(l1)) : 1;
        const end = Math.min(lines.length, l2 ? Number(l2) : l1 ? start : Math.min(lines.length, 40));
        out = {
          kind: 'github-code',
          url,
          repo: `${owner}/${repo}`,
          path,
          ref,
          startLine: start,
          endLine: end,
          language: EXT_LANG[path.split('.').pop()?.toLowerCase() ?? ''] ?? '',
          code: lines.slice(start - 1, Math.min(end, start - 1 + 200)).join('\n'),
        };
      } else if (cfg.JIRA_BASE_URL && url.startsWith(`${cfg.JIRA_BASE_URL}/browse/`)) {
        const key = url.split('/browse/')[1].replace(/\/$/, '');
        if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return null;
        const auth =
          cfg.JIRA_EMAIL && cfg.JIRA_TOKEN
            ? `Basic ${Buffer.from(`${cfg.JIRA_EMAIL}:${cfg.JIRA_TOKEN}`).toString('base64')}`
            : cfg.JIRA_TOKEN
              ? `Bearer ${cfg.JIRA_TOKEN}`
              : undefined;
        const r = await fetchImpl(`${cfg.JIRA_BASE_URL}/rest/api/2/issue/${key}?fields=summary,status,assignee,issuetype`, {
          headers: { accept: 'application/json', ...(auth ? { authorization: auth } : {}) },
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) throw new Error(`jira ${r.status}`);
        const data: any = await r.json();
        out = {
          kind: 'jira',
          url,
          key,
          title: data.fields?.summary ?? key,
          status: data.fields?.status?.name ?? '',
          assignee: data.fields?.assignee?.displayName ?? null,
          type: data.fields?.issuetype?.name ?? '',
        };
      }
    } catch {
      out = null;
    }
    cache.set(url, out);
    return out;
  };
}

export async function registerEmbedRoutes(app: FastifyInstance, fetchImpl?: typeof fetch) {
  const fetchEmbed = createEmbedFetcher(app.ctx.cfg, fetchImpl);
  app.get('/api/embeds', async (req, reply) => {
    requireUser(req);
    const { url } = req.query as { url?: string };
    if (!url || url.length > 2000) throw badRequest('url is required');
    // only fixed, allow-listed hosts are ever contacted (no SSRF via user URLs)
    const e = await fetchEmbed(url);
    if (!e) return reply.code(404).send({ error: 'not_embeddable' });
    return e;
  });
}
