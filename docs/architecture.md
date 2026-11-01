# Architecture

```
Browser (React + CodeMirror 6)
   │  REST/JSON  +  WebSocket /api/ws (presence, live updates, notifications)
   ▼
Folio container (Fastify, stateless, N replicas)
   ├── auth: sessions (HTTP-only cookie) · API tokens (Bearer) · OIDC · CSRF header check
   ├── documents service ──► Storage driver ──► S3 / MinIO  or  local filesystem
   │      └─ on save: parse Markdown → links, tags, mentions, title, search text
   ├── sharing / access control (workspace roles + document/folder shares, inherited)
   ├── notifications (in-app + e-mail)        ├── git sync (git CLI, token via GIT_ASKPASS)
   ├── embeds (GitHub/Jira allow-list only)   └── optional AI assist (Anthropic API)
   ▼
PostgreSQL: users, sessions, permissions, link index, tags, comments, revisions, full-text search,
            presence, and the cross-replica event bus (LISTEN/NOTIFY)
```

## Key decisions

- **Plain Markdown is the source of truth.** Each document's current content and each revision
  is a Markdown blob in storage (`workspaces/<ws>/docs/<id>.md`). Postgres holds only metadata
  and indexes. Exports and Git sync write the folder tree as `.md` files and add the stable
  document id to front matter (`id:`), so re-imports and pulls update the right document even
  after renames. The id is stripped again on import, which keeps documents clean in the editor.
- **One parser everywhere.** `packages/markdown` (unified/remark) is used by the server, for
  indexing and link rewriting, and by the browser, for rendering. Both agree on what counts as a
  link, tag or mention, and code blocks are always excluded.
- **Live preview, not WYSIWYG.** CodeMirror decorations hide the syntax and render widgets
  (checkboxes, images, math) without changing the text, so a file never gets reformatted behind
  the user's back.
- **Optimistic concurrency.** Each save sends `baseVersion`. A stale save gets `409` with the
  current content, and the UI offers "keep mine" or "use theirs". Viewers who have no unsaved
  edits get other people's saves applied live, through the WebSocket. Revisions from the same
  author within 10 minutes are merged into one, so autosave doesn't flood the history.
- **Access control** = max(workspace role, direct document share, shares on any ancestor
  folder). Documents a user can't read return `404`. Search, backlinks and tag lists are filtered
  through the same `ACCESSIBLE_DOCS_CTE`.
- **Horizontal scaling.** No in-process state is required. WebSocket events fan out through
  Postgres `LISTEN/NOTIFY`, and presence is a Postgres table with heartbeats. Migrations take an
  advisory lock, so several replicas or initContainers can start at the same time.

## Security

- Passwords are hashed with argon2id. Session, verification and reset tokens are random and
  stored only as SHA-256 hashes. A password reset revokes all sessions. Login responses are the
  same for unknown users and wrong passwords.
- CSRF: cookie-authenticated mutations must send `X-Requested-With: folio`, and the cookie is
  `SameSite=Lax`.
- Rendered HTML goes through `rehype-sanitize`, with a strict CSP: no `unsafe-eval`, and Vega
  runs with its AST interpreter.
- Uploads are limited by an allow-list plus a magic-number check, a size limit, and `nosniff`
  with a sandbox CSP when served. SVG and HTML uploads are rejected.
- Embeds only contact fixed hosts (GitHub API, the configured Jira), so there's no SSRF. Git
  remotes must be `https://`. Git tokens are encrypted with AES-256-GCM (key derived from
  `APP_SECRET`) and are never returned or logged.
- Auth endpoints are rate-limited.
