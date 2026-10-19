# JOC: one image. The Hono server (apps/server) serves the API and the built web app
# (apps/web/dist, via WEB_DIST), so the dashboard and the API are same-origin.

# ─── Web build ──────────────────────────────────────────────────────────────
# Output is static files, so build on the runner's native platform (no QEMU).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS web

RUN npm install -g pnpm@12.14.0
WORKDIR /workspace

# --ignore-scripts: there's no .git in the build context, so skip the git-hook setup
# (simple-git-hooks); the web build needs no install scripts.

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/plugin/package.json apps/plugin/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter @joc/web build

# ─── Runtime ────────────────────────────────────────────────────────────────
# The server runs src/index.ts with Node's type stripping, which refuses .ts files under
# node_modules. So keep the workspace layout (packages/* symlinked, not copied into
# node_modules) instead of using `pnpm deploy`.
FROM node:24-bookworm-slim AS runtime

RUN npm install -g pnpm@12.14.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/db/package.json packages/db/
# --ignore-scripts: production deps need no install scripts, and the root `prepare`
# (simple-git-hooks) is a dev dependency that isn't installed here.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @joc/server... \
  && pnpm store prune \
  && npm uninstall -g pnpm

COPY packages/protocol/src packages/protocol/src
COPY packages/db/src packages/db/src
COPY apps/server/src apps/server/src
COPY --from=web /workspace/apps/web/dist apps/web/dist

ENV NODE_ENV=production \
  PORT=3000 \
  WEB_DIST=/app/apps/web/dist

USER node
WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "src/index.ts"]
