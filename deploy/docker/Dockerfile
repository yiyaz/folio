# syntax=docker/dockerfile:1.7
# Folio: multi-stage build producing a small, non-root runtime image.
ARG NODE_IMAGE=node:22-alpine

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/markdown/package.json packages/markdown/
COPY packages/cli/package.json packages/cli/
# optional build secret "ca" lets builds behind a TLS-intercepting proxy trust its CA
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @folio/web build && pnpm --filter @folio/server build
# production node_modules for the server only (the markdown package is bundled into dist)
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    pnpm --filter @folio/server deploy --prod --legacy /out && \
    rm -rf /out/src /out/test /out/*.config.ts /out/tsconfig.json

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
# git is needed for workspace Git sync. Set RUNTIME_PACKAGES="" to skip (Git sync then reports an error).
ARG RUNTIME_PACKAGES="git"
RUN if [ -n "$RUNTIME_PACKAGES" ]; then apk add --no-cache $RUNTIME_PACKAGES && rm -rf /var/cache/apk/*; fi
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web \
    STORAGE_FS_ROOT=/data/storage \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /src/apps/web/dist ./web
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# the server handles SIGTERM itself (drains, then exits), so node can run as PID 1
CMD ["node", "dist/main.js"]
