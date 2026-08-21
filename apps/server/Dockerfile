# syntax=docker/dockerfile:1
# Build context is the repository root (see docker-compose.yml / build context).

# --- builder: install the workspace, compile, and carve out a prod deploy ----
FROM node:22-slim AS builder
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Produce a self-contained production deploy of just the server + its runtime
# workspace deps (config/schema/db/core/auth/mcp) — NOT the marketing/docs apps
# or any dev toolchain. `pnpm deploy` flattens the workspace links and prunes to
# production deps, so the runtime image ships only what `node` actually loads.
# (The db package's `files` includes its migrations, so they come along.)
RUN CI=1 pnpm --filter=@rooster/server --prod --legacy deploy /prod

# --- runner: run the Hono server (no pnpm, no toolchain) ---------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Default SQLite data location so a bare `docker run` starts without crashing.
# Mount a named/bind volume at /data to persist it; without one it's ephemeral.
# Override DATABASE_URL for Postgres/Turso.
ENV DATABASE_URL=file:/data/rooster.db
RUN mkdir -p /data

# The deploy dir has the server package at its root: dist/ + node_modules/.
COPY --from=builder /prod /app

VOLUME /data
EXPOSE 3000

# The Node entry auto-migrates the domain tables and creates better-auth's tables
# on boot (ROO-66). On Postgres, run `auth:migrate` once (see docs/SELF_HOSTING.md).
CMD ["node", "dist/node.js"]
