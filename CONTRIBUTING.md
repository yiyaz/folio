# Contributing

## Setup

```bash
pnpm install
docker compose up -d db mailpit
cp .env.example .env
pnpm dev            # API :3000, web :5173
```

## Before you open a pull request

```bash
pnpm lint && pnpm format:check && pnpm typecheck
TEST_DATABASE_URL=postgres://folio:folio@localhost:5432/postgres pnpm test
pnpm test:e2e       # for user-facing changes
```

Without `TEST_DATABASE_URL` the server tests start Postgres with Testcontainers (Docker required).

## Standards

- **Tests are part of the change.** Bug fixes come with a test that fails without the fix. Server
  behaviour is tested through the HTTP API against a real Postgres, not mocks. Coverage
  thresholds in `vitest.config.ts` only move up.
- **Authorization on every endpoint.** Use `documentAccess` / `folderAccess` / `workspaceRole` and
  `assertCan`. Resources a user can't read return 404, not 403.
- **Validate all input** with zod at the route boundary. Never interpolate user input into SQL;
  use parameters.
- **Storage writes are immutable.** Write a new blob, point the row at it inside the
  transaction, garbage-collect afterwards (see `services/documents.ts`).
- **Database changes** go in a new numbered migration; never edit a shipped one. Migrations must
  be safe to run while the previous version is still serving traffic.
- **No new runtime dependency** without a reason in the PR description (size, maintenance,
  licence).
- Formatting is Prettier's; lint is ESLint. CI enforces both.
- Commit messages: imperative mood, short subject, body explaining _why_.
