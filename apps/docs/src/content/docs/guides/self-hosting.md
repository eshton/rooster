---
title: Self-hosting
description: Run your own Rooster instance on Node, Docker or Vercel, backed by Postgres or SQLite.
---

Rooster is one deployable (`@rooster/server`) over one database. The driver is
chosen purely from the `DATABASE_URL` scheme.

## Configuration

Copy `.env.example` to `.env`. The essentials:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `postgres://…`, `file:…` (SQLite) or `libsql://…` (Turso) |
| `ROOSTER_AUTH_SECRET` | ≥ 16 chars; `openssl rand -base64 32` |
| `ROOSTER_BASE_URL` | public URL, no trailing slash |
| `ROOSTER_SIGNUP_TOKEN` | gates tenant self-registration (set on public instances) |
| `GITHUB_CLIENT_ID` / `…_SECRET` | optional human OAuth login (also Google) |

## Two sets of tables

Rooster keeps **two** sets of tables in the same database:

1. **Domain tables** (orgs, teams, projects, tickets, agents, audit log …) —
   migrated by Rooster:

   ```bash
   pnpm --filter @rooster/db build
   DATABASE_URL=… pnpm --filter @rooster/db db:migrate
   ```

   The Node entry also auto-migrates on startup; the command above is for
   serverless / CI where you migrate once, out of band.

2. **Auth tables** (user, session, account, oauth* …) — owned and migrated by
   **better-auth** itself, on Postgres:

   ```bash
   DATABASE_URL=postgres://… pnpm --filter @rooster/server auth:migrate
   ```

   Use `auth:generate` first if you want to review the SQL.

## Docker (published image)

The fastest real instance — no clone, no build. Pull the published image and go;
it auto-migrates the domain tables and bootstraps an owner on first boot.

**Personal (SQLite, no login):** local mode gates `/mcp` on a static token and
auto-signs-you-in on the dashboard. Bound to loopback.

```bash
docker run -p 127.0.0.1:3000:3000 -v rooster-data:/data \
  -e ROOSTER_LOCAL_MODE=1 \
  -e ROOSTER_LOCAL_TOKEN=$(openssl rand -base64 24) \
  -e ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) \
  ghcr.io/eshton/rooster:latest
```

**Shared (SQLite, OAuth login):** set an admin to bootstrap, keep the full login
flow.

```bash
docker run -p 3000:3000 -v rooster-data:/data \
  -e ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) \
  -e ROOSTER_ADMIN_EMAIL=you@example.com \
  -e ROOSTER_ADMIN_PASSWORD=change-me-8+chars \
  ghcr.io/eshton/rooster:latest
```

Compose files are provided: `docker-compose.local.yml` (local mode),
`docker-compose.sqlite.yml` (SQLite + login), and `docker-compose.yml`
(server + Postgres). `DATABASE_URL` defaults to `file:/data/rooster.db` inside
the image — mount a volume at `/data` to persist it. Name your workspace with
`ROOSTER_ADMIN_WORKSPACE` / `ROOSTER_ADMIN_PROJECT_KEY`.

Images are published to GHCR manually via the **Publish image** workflow
(Actions → Run workflow → pick a tag).

## Run (from source)

```bash
pnpm build
pnpm --filter @rooster/server start
```

## Deploy targets

- **Node / Docker / VPS** — `start` auto-migrates the domain tables and creates
  better-auth's tables on boot, so **sessions persist** on a SQLite/libSQL file
  (or Turso) as well as Postgres.
- **Vercel** — deploy the Hono app as a function. Run `db:migrate` and (on
  Postgres) `auth:migrate` as a one-off (deploy hook), not on cold start. Use a
  hosted Postgres (Neon / Vercel Postgres) — the in-memory adapter is **not**
  durable on serverless.

:::note[Session durability]
On a SQLite/libSQL **file** (or Turso), better-auth's tables are created on the
same connection at boot, so OAuth logins persist across restarts. Only the
ephemeral in-memory DB (`file::memory:`, dev/tests) and serverless resets
sessions. Local mode has no sessions at all (it auto-authenticates).
:::
