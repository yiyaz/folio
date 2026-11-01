# Deployment

## Container image

```bash
docker build -f deploy/docker/Dockerfile -t folio:0.1.0 .
```

The image is a multi-stage build on `node:22-alpine`. It runs as the non-root `node` user (uid
1000) with `git` included for Git sync, and has a `HEALTHCHECK` on `/healthz`. Build arguments:

- `NODE_IMAGE`: base image (e.g. a registry mirror).
- `RUNTIME_PACKAGES`: OS packages for the runtime, default `git`. Set it to an empty value only if
  you don't need Git sync.
- To build behind a TLS-intercepting proxy, pass its CA certificate with
  `--secret id=ca,src=/path/ca.pem`.

## Single host (docker compose)

`docker compose up -d` starts Postgres, MinIO, Mailpit and Folio. Change `APP_SECRET`, the
passwords and `PUBLIC_URL` in `docker-compose.yml` before exposing it.

## Kubernetes (Helm)

```bash
kubectl create namespace folio
kubectl -n folio create secret generic folio-secrets \
  --from-literal=APP_SECRET="$(openssl rand -hex 32)" \
  --from-literal=DATABASE_URL='postgres://folio:…@my-postgres:5432/folio' \
  --from-literal=S3_ACCESS_KEY_ID=… --from-literal=S3_SECRET_ACCESS_KEY=… \
  --from-literal=MAIL_TRANSPORT='smtp://user:pass@smtp.example.com:587'

helm upgrade --install folio deploy/helm/folio -n folio \
  --set image.repository=ghcr.io/your-org/folio --set image.tag=0.1.0 \
  --set existingSecret=folio-secrets \
  --set publicUrl=https://docs.example.com --set ingress.host=docs.example.com \
  --set storage.s3.bucket=folio-docs
```

What the chart sets up:

- **Deployment** with 2+ replicas, a rolling update with `maxUnavailable: 0`, startup, liveness
  (`/healthz`) and readiness (`/readyz`, which checks Postgres and storage) probes, a read-only
  root filesystem, all capabilities dropped, seccomp `RuntimeDefault`, and spread across nodes.
- **Migrations** run in an initContainer (`node dist/migrate-cli.js`). It waits for the database
  and takes an advisory lock, so concurrent pods are safe.
- **Ingress** with TLS (cert-manager annotation) and long proxy timeouts for WebSockets.
- **HPA** on CPU (2–8 replicas) and a **PodDisruptionBudget**. **NetworkPolicy** and a
  Prometheus **ServiceMonitor** are optional.
- **Secrets**: point `existingSecret` at your own Secret, or let the chart generate one
  (`APP_SECRET` is generated once and kept across upgrades).
- **Evaluation mode**: `--set postgresql.enabled=true --set minio.enabled=true` runs
  single-instance Postgres and MinIO in the cluster. Don't use this for production data.
- **Filesystem storage** (`storage.driver=fs`) needs a ReadWriteMany volume to run more than one
  replica. The chart refuses to render a configuration that would lose data.

### Graceful shutdown

On SIGTERM the server fails `/readyz` for `SHUTDOWN_GRACE_MS`, so the load balancer stops
sending traffic. It then closes WebSockets, finishes in-flight requests and exits. Keep
`terminationGracePeriodSeconds` above that delay plus about 10 seconds.

### Observability

- Logs: JSON (pino) on stdout. Authorization and cookie headers are redacted.
- Metrics: `/metrics` exposes `folio_http_request_duration_seconds{method,route,status}`,
  `folio_document_saves_total` and the Node.js defaults.
- Tracing: set `config.otel.endpoint` to an OTLP/HTTP collector.

### Backups

- **Postgres**: use managed backups or point-in-time recovery, or schedule
  `pg_dump -Fc "$DATABASE_URL"` with a CronJob.
- **Object storage**: enable bucket versioning and lifecycle rules. Documents and revisions are
  written once per version, so versioning is cheap.
- **Portable copy**: `folio pull <workspace-id> backup/` (CLI) or the workspace "Download .zip"
  button gives you plain Markdown you can open anywhere.

## Load testing

```bash
docker run --rm -i --network host -e BASE_URL=http://localhost:3000 grafana/k6 run - < loadtest/folio.js
```

The script ramps up to 20 concurrent editors that save, read and search continuously. It fails
if more than 1% of requests error or if p95 save or search latency goes over 300 ms. Sign-up
must be open and `RATE_LIMIT_AUTH_PER_MIN` high enough for 20 sign-ups.
