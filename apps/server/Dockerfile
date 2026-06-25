# syntax=docker/dockerfile:1
# Build context is the repository root (see docker-compose.yml / build context).

# --- builder: install the workspace and compile all packages ----------------
FROM node:22-slim AS builder
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- runner: run the Hono server --------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV NODE_ENV=production
ENV PORT=3000
RUN corepack enable

# Copy the built workspace (preserves pnpm's node_modules symlink layout).
COPY --from=builder /app /app

EXPOSE 3000

# The Node entry auto-migrates the domain tables on boot. better-auth owns its
# own tables on Postgres — run `auth:migrate` once (see docs/SELF_HOSTING.md).
CMD ["node", "apps/server/dist/node.js"]
