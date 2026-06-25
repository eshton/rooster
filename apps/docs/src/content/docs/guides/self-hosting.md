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

## Run

```bash
pnpm build
pnpm --filter @rooster/server start
```

## Deploy targets

- **Node / Docker / VPS** — `start` auto-migrates domain tables on boot;
  persistent auth works out of the box on Postgres.
- **Vercel** — deploy the Hono app as a function. Run `db:migrate` and
  `auth:migrate` as a one-off (deploy hook), not on cold start. Use a hosted
  Postgres (Neon / Vercel Postgres). better-auth uses a real connection pool on
  Postgres — the in-memory adapter is dev/SQLite only and is **not** durable on
  serverless.

:::caution
The in-memory auth adapter loses all sessions/tokens between invocations. Always
use Postgres (or another durable store) for anything beyond local dev.
:::
