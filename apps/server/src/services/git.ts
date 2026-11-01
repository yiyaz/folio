import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppContext, AuthUser } from '../context.js';
import { one } from '../db.js';
import { badRequest } from '../errors.js';
import { exportWorkspaceFiles, importFiles, type ImportReport } from './transfer.js';

const run = promisify(execFile);

export interface GitConfig {
  remote: string;
  branch: string;
  username: string;
  tokenEnc?: string | null;
  subdir?: string;
  lastPushAt?: string;
  lastPullAt?: string;
  lastCommit?: string;
  lastError?: string | null;
}

export function validateRemote(ctx: AppContext, remote: string) {
  if (/^https:\/\/[^\s@]+$/.test(remote)) return;
  if (ctx.cfg.GIT_ALLOW_FILE_REMOTES && (remote.startsWith('file://') || remote.startsWith('/'))) return;
  throw badRequest('Remote must be an https:// URL (credentials go in the token field, not the URL)');
}

export async function getGitConfig(ctx: AppContext, workspaceId: string): Promise<GitConfig | null> {
  const r = await one<{ git_config: GitConfig | null }>(ctx.db, 'SELECT git_config FROM workspaces WHERE id = $1', [workspaceId]);
  return r?.git_config ?? null;
}

async function setGitState(ctx: AppContext, workspaceId: string, patch: Partial<GitConfig>) {
  await ctx.db.query(`UPDATE workspaces SET git_config = COALESCE(git_config, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [workspaceId, JSON.stringify(patch)]);
}

/** Run git with credentials supplied through GIT_ASKPASS so tokens never hit argv or logs. */
async function withRepo<T>(ctx: AppContext, cfg: GitConfig, fn: (git: (...args: string[]) => Promise<string>, dir: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-git-'));
  const askpass = path.join(tmp, 'askpass.sh');
  await fs.writeFile(askpass, '#!/bin/sh\ncase "$1" in Username*) echo "$FOLIO_GIT_USER";; *) echo "$FOLIO_GIT_TOKEN";; esac\n', { mode: 0o700 });
  const token = cfg.tokenEnc ? ctx.secrets.decrypt(cfg.tokenEnc) : '';
  const env = {
    PATH: process.env.PATH,
    HOME: tmp,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: askpass,
    FOLIO_GIT_USER: cfg.username || 'x-access-token',
    FOLIO_GIT_TOKEN: token,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const dir = path.join(tmp, 'repo');
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await run('git', args, { cwd: dir, env, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    } catch (e: any) {
      const msg = String(e.stderr || e.message).replaceAll(token || '\u0000', '***');
      throw badRequest(`git ${args[0]} failed: ${msg.trim().split('\n').slice(-3).join(' ')}`);
    }
  };
  try {
    await fs.mkdir(dir);
    return await fn(git, dir);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function cloneOrInit(git: (...a: string[]) => Promise<string>, cfg: GitConfig): Promise<boolean> {
  await git('init', '-q', '-b', cfg.branch);
  await git('remote', 'add', 'origin', cfg.remote);
  const heads = await git('ls-remote', '--heads', 'origin', cfg.branch);
  if (!heads.trim()) return false;
  await git('fetch', '-q', '--depth', '1', 'origin', cfg.branch);
  await git('checkout', '-q', '-B', cfg.branch, `origin/${cfg.branch}`);
  return true;
}

async function walkMarkdown(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkMarkdown(root, p)));
    else if (/\.(md|markdown)$/i.test(e.name)) out.push(p);
  }
  return out;
}

/** Commit the workspace as Markdown files and push to the configured branch. */
export async function gitPush(ctx: AppContext, user: AuthUser, workspaceId: string, message?: string) {
  const cfg = await getGitConfig(ctx, workspaceId);
  if (!cfg?.remote) throw badRequest('Git sync is not configured for this workspace');
  try {
    const result = await withRepo(ctx, cfg, async (git, dir) => {
      await cloneOrInit(git, cfg);
      const sub = cfg.subdir ? cfg.subdir.replace(/^\/+|\/+$/g, '') : '';
      const base = sub ? path.join(dir, sub) : dir;
      // replace all tracked markdown with the current workspace state
      for (const f of await fs.mkdir(base, { recursive: true }).then(() => walkMarkdown(base))) await fs.rm(path.join(base, f));
      const files = await exportWorkspaceFiles(ctx, workspaceId);
      for (const f of files) {
        const p = path.join(base, f.path);
        if (!p.startsWith(base)) continue;
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, f.content);
      }
      await git('add', '-A');
      const status = await git('status', '--porcelain');
      if (!status.trim()) return { pushed: false, commit: (await git('rev-parse', 'HEAD').catch(() => '')).trim(), files: files.length };
      await git('-c', `user.name=${user.displayName}`, '-c', `user.email=${user.email}`, 'commit', '-q', '-m', message || `Folio sync by ${user.username}`);
      await git('push', '-q', 'origin', `HEAD:${cfg.branch}`);
      return { pushed: true, commit: (await git('rev-parse', 'HEAD')).trim(), files: files.length };
    });
    await setGitState(ctx, workspaceId, { lastPushAt: new Date().toISOString(), lastCommit: result.commit, lastError: null });
    return result;
  } catch (e: any) {
    await setGitState(ctx, workspaceId, { lastError: e.message });
    throw e;
  }
}

/** Pull Markdown files from the branch and import new/changed documents. */
export async function gitPull(ctx: AppContext, user: AuthUser, workspaceId: string): Promise<ImportReport & { commit: string }> {
  const cfg = await getGitConfig(ctx, workspaceId);
  if (!cfg?.remote) throw badRequest('Git sync is not configured for this workspace');
  try {
    const result = await withRepo(ctx, cfg, async (git, dir) => {
      const exists = await cloneOrInit(git, cfg);
      if (!exists) throw badRequest(`Branch "${cfg.branch}" does not exist on the remote yet - push first`);
      const sub = cfg.subdir ? cfg.subdir.replace(/^\/+|\/+$/g, '') : '';
      const base = sub ? path.join(dir, sub) : dir;
      const paths = await walkMarkdown(base).catch(() => [] as string[]);
      const files = await Promise.all(paths.map(async (p) => ({ path: p, content: await fs.readFile(path.join(base, p), 'utf8') })));
      const report = await importFiles(ctx, user, workspaceId, files, { matchByPath: true });
      return { ...report, commit: (await git('rev-parse', 'HEAD')).trim() };
    });
    await setGitState(ctx, workspaceId, { lastPullAt: new Date().toISOString(), lastCommit: result.commit, lastError: null });
    return result;
  } catch (e: any) {
    await setGitState(ctx, workspaceId, { lastError: e.message });
    throw e;
  }
}
