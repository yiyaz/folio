import type { AppContext, AuthUser } from '../context.js';
import { one, tx } from '../db.js';
import { createDocument } from './documents.js';

export const WELCOME_DOC = `# Welcome to Folio

Folio stores everything as **plain Markdown**. Format text with the toolbar, keyboard shortcuts
(\`Ctrl/Cmd+B\`, \`Ctrl/Cmd+I\`) or by typing \`/\` at the start of a line.

## Linking documents
- Type \`[[\` to link another document, e.g. [[Getting started]].
- Link to a heading with \`[[Doc#Heading]]\` or to a paragraph with \`[[Doc#^block-id]]\`.
- Every document shows its **backlinks** in the side panel.

## Collaboration
- Mention people with \`@username\` - they get a notification.
- Organise with tags like #welcome or front-matter \`tags: [a, b]\`.
- Use **Share** to invite others as viewer, commenter or editor.

## For engineers and data scientists
- Math: $e^{i\\pi} + 1 = 0$
- Diagrams with \`mermaid\` code blocks, charts with \`vega-lite\`, sortable tables with \`csv\`
- Runnable Python with a \`python run\` code block (type \`/\` for all block types)

A paragraph you can link to directly. ^welcome-anchor
`;

export const GETTING_STARTED_DOC = `# Getting started

Press \`Ctrl/Cmd+P\` to jump to any document and \`Ctrl/Cmd+K\` for the command palette.

Back to [[Welcome to Folio#Linking documents]], or see the anchored paragraph [[Welcome to Folio#^welcome-anchor]].
`;

export async function createWorkspace(ctx: AppContext, user: AuthUser, name: string, opts: { seed?: boolean } = {}) {
  const ws = await tx(ctx.db, async (c) => {
    const ws = await one<{ id: string; name: string; owner_id: string; created_at: Date }>(
      c,
      'INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id, created_at',
      [name, user.id],
    );
    await c.query(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`, [ws!.id, user.id]);
    return ws!;
  });
  if (opts.seed) {
    await createDocument(ctx, user, { workspaceId: ws.id, folderId: null, name: 'Welcome to Folio', content: WELCOME_DOC });
    await createDocument(ctx, user, { workspaceId: ws.id, folderId: null, name: 'Getting started', content: GETTING_STARTED_DOC });
  }
  return ws;
}
