import { isAuthorship, toSpans, uniform, type Author, type Authorship, type Span } from '@folio/markdown';
import type { AppContext } from '../context.js';
import { many } from '../db.js';

export interface AiClaim {
  from: number;
  to: number;
  generationId: string;
}

export const userAuthor = (id: string): Author => ({ kind: 'user', id });

/** Stored authorship, or (legacy documents) everything attributed to the creator. */
export function authorshipOf(
  doc: { authorship: unknown; created_by: string | null; updated_by: string | null },
  length: number,
  fallbackUser: string,
): Authorship {
  if (isAuthorship(doc.authorship)) return doc.authorship;
  return uniform(length, userAuthor(doc.created_by ?? doc.updated_by ?? fallbackUser));
}

/**
 * Turn a client's "this text came from the AI" claims into trusted spans. A claim counts only if
 * the generation exists, was requested by this user (for this document or a new one), and the
 * claimed text actually occurs in the generation's output. Anything else is attributed to the
 * human who saved it — clients can never attribute text to another person.
 */
export async function verifyClaims(ctx: AppContext, userId: string, docId: string, content: string, claims: AiClaim[] | undefined): Promise<Span[]> {
  if (!claims?.length) return [];
  const ids = [...new Set(claims.map((c) => c.generationId))].slice(0, 100);
  const gens = await many<{ id: string; model: string; output: string; document_id: string | null }>(
    ctx.db,
    `SELECT id, model, output, document_id FROM ai_generations WHERE id = ANY($1::uuid[]) AND user_id = $2 AND status = 'done'`,
    [ids, userId],
  );
  const byId = new Map(gens.map((g) => [g.id, g]));
  const out: Span[] = [];
  for (const c of claims.slice(0, 2000)) {
    const g = byId.get(c.generationId);
    if (!g || (g.document_id && g.document_id !== docId)) continue;
    if (!Number.isInteger(c.from) || !Number.isInteger(c.to) || c.from < 0 || c.to > content.length || c.to <= c.from) continue;
    const text = content.slice(c.from, c.to);
    // whitespace-only fragments carry no authorship worth claiming
    if (!text.trim() || !g.output.includes(text)) continue;
    out.push({ from: c.from, to: c.to, author: { kind: 'ai', generationId: g.id, model: g.model, requestedBy: userId } });
  }
  return out;
}

export interface AuthorMeta {
  people: Record<string, { id: string; username: string; displayName: string; hasAvatar: boolean }>;
  generations: Record<
    string,
    { id: string; model: string; prompt: string; context: { id: string; name: string }[]; requestedBy: string | null; createdAt: string }
  >;
}

/** Names and provenance for the authors appearing in an authorship (for tooltips and the panel). */
export async function describeAuthors(ctx: AppContext, a: Authorship, opts: { includePrompts?: boolean } = {}): Promise<AuthorMeta> {
  const userIds = new Set<string>();
  const genIds = new Set<string>();
  for (const au of a.authors) {
    if (au.kind === 'user') userIds.add(au.id);
    else {
      genIds.add(au.generationId);
      userIds.add(au.requestedBy);
    }
  }
  const users = userIds.size
    ? await many<{ id: string; username: string; displayName: string; hasAvatar: boolean }>(
        ctx.db,
        `SELECT id, username, display_name AS "displayName", (avatar_key IS NOT NULL) AS "hasAvatar" FROM users WHERE id::text = ANY($1::text[])`,
        [[...userIds]],
      )
    : [];
  const gens = genIds.size
    ? await many<{ id: string; model: string; prompt: string; context: { id: string; name: string }[]; user_id: string | null; created_at: Date }>(
        ctx.db,
        'SELECT id, model, prompt, context, user_id, created_at FROM ai_generations WHERE id = ANY($1::uuid[])',
        [[...genIds]],
      )
    : [];
  return {
    people: Object.fromEntries(users.map((u) => [u.id, u])),
    generations: Object.fromEntries(
      gens.map((g) => [
        g.id,
        {
          id: g.id,
          model: g.model,
          prompt: opts.includePrompts === false ? '' : g.prompt,
          context: opts.includePrompts === false ? [] : g.context,
          requestedBy: g.user_id,
          createdAt: g.created_at.toISOString(),
        },
      ]),
    ),
  };
}

export { toSpans };
