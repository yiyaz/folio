import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/plugin.js';
import { assertCan, assertUuid, workspaceRole } from '../access.js';
import { getGitConfig, gitPull, gitPush, validateRemote, type GitConfig } from '../services/git.js';

export async function registerGitRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const present = (c: GitConfig | null) => (c ? { remote: c.remote, branch: c.branch, username: c.username, subdir: c.subdir ?? '', hasToken: !!c.tokenEnc, lastPushAt: c.lastPushAt, lastPullAt: c.lastPullAt, lastCommit: c.lastCommit, lastError: c.lastError } : null);

  app.get('/api/workspaces/:id/git', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    assertCan(await workspaceRole(ctx.db, u.id, id), 'manage');
    return present(await getGitConfig(ctx, id));
  });

  app.put('/api/workspaces/:id/git', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    assertCan(await workspaceRole(ctx.db, u.id, id), 'manage');
    const body = z
      .object({
        remote: z.string().trim().min(1).max(500),
        branch: z.string().trim().regex(/^[\w.\-/]+$/).max(100).default('main'),
        username: z.string().trim().max(100).default('x-access-token'),
        token: z.string().max(500).optional(), // omitted = keep existing, "" = clear
        subdir: z.string().trim().regex(/^[\w.\-/]*$/).max(200).default(''),
      })
      .parse(req.body);
    validateRemote(ctx, body.remote);
    const prev = await getGitConfig(ctx, id);
    const next: GitConfig = {
      ...(prev ?? {}),
      remote: body.remote,
      branch: body.branch,
      username: body.username,
      subdir: body.subdir,
      tokenEnc: body.token === undefined ? prev?.tokenEnc ?? null : body.token ? ctx.secrets.encrypt(body.token) : null,
    };
    await ctx.db.query('UPDATE workspaces SET git_config = $2 WHERE id = $1', [id, JSON.stringify(next)]);
    return present(next);
  });

  app.delete('/api/workspaces/:id/git', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    assertCan(await workspaceRole(ctx.db, u.id, id), 'manage');
    await ctx.db.query('UPDATE workspaces SET git_config = NULL WHERE id = $1', [id]);
    return { ok: true };
  });

  app.post('/api/workspaces/:id/git/push', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    assertCan(await workspaceRole(ctx.db, u.id, id), 'edit');
    const { message } = z.object({ message: z.string().max(500).optional() }).parse(req.body ?? {});
    return gitPush(ctx, u, id, message);
  });

  app.post('/api/workspaces/:id/git/pull', async (req) => {
    const u = requireUser(req);
    const { id } = req.params as { id: string };
    assertUuid(id);
    assertCan(await workspaceRole(ctx.db, u.id, id), 'edit');
    return gitPull(ctx, u, id);
  });
}
