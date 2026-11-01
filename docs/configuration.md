# Configuration

All settings are environment variables (see `apps/server/src/config.ts`). In Kubernetes the Helm
chart maps `values.yaml` onto them.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://folio:folio@localhost:5432/folio` | PostgreSQL 14+ connection string |
| `APP_SECRET` | dev value | **Required in production.** 32+ random characters. Signs cookies and encrypts stored secrets |
| `PUBLIC_URL` | `http://localhost:3000` | External URL, used in e-mails, OIDC redirects and public links |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS (the Helm chart does this automatically) |
| `STORAGE_DRIVER` | `fs` | `fs` (local directory) or `s3` |
| `STORAGE_FS_ROOT` | `./.data/storage` | Directory for the `fs` driver |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | `folio`, `us-east-1`, –, –, –, `true` | S3/MinIO settings. The bucket is created if it doesn't exist. Leave the keys empty to use IAM/IRSA |
| `MAIL_TRANSPORT` | `log` | `smtp://user:pass@host:port`, `log` (print to stdout) or `file:/dir` (JSON files, for tests) |
| `MAIL_FROM` | `Folio <no-reply@folio.local>` | Sender address |
| `SIGNUP_MODE` | `open` | `open`, `domain`, `invite` or `closed`. Admins can override this in the UI |
| `SIGNUP_ALLOWED_DOMAINS` | – | Comma-separated domains for `domain` mode |
| `REQUIRE_EMAIL_VERIFICATION` | `true` | New accounts must confirm their e-mail before signing in (the first account and invited users are exempt) |
| `SESSION_TTL_DAYS` | `30` | Session lifetime |
| `RATE_LIMIT_AUTH_PER_MIN` | `10` | Per-IP limit on login, sign-up and reset endpoints |
| `MAX_UPLOAD_MB` | `25` | Attachment and import size limit |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_NAME` | – | Enables "Continue with …" single sign-on (Keycloak, Google, Entra ID, Okta). Redirect URI: `${PUBLIC_URL}/api/auth/oidc/callback` |
| `WEB_DIST` | – | Directory of the built web app to serve (set in the container image) |
| `LOG_LEVEL` | `info` | pino log level |
| `MIGRATE_ON_START` | `true` | Run migrations at startup (the Helm chart uses an initContainer instead) |
| `SHUTDOWN_GRACE_MS` | `5000` | Time between failing `/readyz` and closing connections on SIGTERM |
| `GITHUB_TOKEN`, `GITHUB_API_URL` | –, `https://api.github.com` | GitHub embeds (PRs, issues, code permalinks). The token is optional, for private repos and higher rate limits |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` | – | Jira issue embeds |
| `GIT_ALLOW_FILE_REMOTES` | `false` | Allow `file://` Git remotes (tests only) |
| `PLANTUML_SERVER` | – | PlantUML server for ```` ```plantuml ```` blocks, e.g. `https://www.plantuml.com/plantuml` |
| `PYODIDE_URL` | jsDelivr | Where browsers load Pyodide for ```` ```python run ```` blocks. Self-host it for air-gapped installs |
| `ANTHROPIC_API_KEY`, `AI_MODEL` | –, `claude-opus-5-5` | Optional AI assist (summarize, explain code, generate docs, improve writing). Selected text is sent to the Anthropic API |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | – | Enables OpenTelemetry tracing (OTLP/HTTP) |
