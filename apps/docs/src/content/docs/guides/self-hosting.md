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

## Semantic search (optional)

Rooster always has keyword search (`search_tickets`). **Semantic** search —
`find_similar_tickets`, `rag_search`, `recall_context` — is **off until you
configure an embeddings provider**. The vectors are stored locally in your
SQLite/libSQL database (native `F32_BLOB` — no extra service for storage); you
only need something to *create* the embeddings.

Rooster calls an **OpenAI-compatible `/v1/embeddings`** endpoint. Set:

| Variable | Purpose |
| --- | --- |
| `ROOSTER_EMBEDDING_URL` | the `/v1/embeddings` endpoint |
| `ROOSTER_EMBEDDING_API_KEY` | the provider key (any non-empty value for local Ollama) |
| `ROOSTER_EMBEDDING_MODEL` | model name |
| `ROOSTER_EMBEDDING_DIMS` | vector size — **must match the model** |

`URL` + `API_KEY` are all-or-nothing; set both or semantic search stays off (a
log line tells you). Common `DIMS`: `nomic-embed-text` = 768, `bge-m3` /
`mxbai-embed-large` = 1024, OpenAI `text-embedding-3-small` = 1536.

**Fully local, zero cloud (bundled Ollama):** `docker-compose.ollama.yml` runs
Ollama alongside Rooster, wired with working defaults (`nomic-embed-text`, 768
dims) — semantic search works out of the box:

```bash
ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) \
ROOSTER_LOCAL_TOKEN=$(openssl rand -base64 24) \
docker compose -f docker-compose.ollama.yml up
```

The first start pulls the embed model (~a minute). Tickets created before it's
ready won't be embedded — run `backfill_embeddings` once to catch up.

**Point at an existing provider** instead — a cloud API:

```bash
-e ROOSTER_EMBEDDING_URL=https://api.openai.com/v1/embeddings \
-e ROOSTER_EMBEDDING_API_KEY=sk-... \
-e ROOSTER_EMBEDDING_MODEL=text-embedding-3-small \
-e ROOSTER_EMBEDDING_DIMS=1536
```

…or an Ollama you already run on the host (`ollama pull nomic-embed-text`):

```bash
-e ROOSTER_EMBEDDING_URL=http://host.docker.internal:11434/v1/embeddings \
-e ROOSTER_EMBEDDING_API_KEY=ollama \
-e ROOSTER_EMBEDDING_MODEL=nomic-embed-text \
-e ROOSTER_EMBEDDING_DIMS=768
```

:::caution[Changing DIMS on an existing database]
The `embeddings` table is sized from `ROOSTER_EMBEDDING_DIMS` when it's first
created. To switch to a model with a different vector size, drop the
`embeddings` table (it recreates on next connect), then re-embed with
`backfill_embeddings`.
:::

## Run (from source)

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

:::caution[Session durability on SQLite]
On SQLite, better-auth uses an in-memory session store, so **OAuth logins reset
when the process restarts** (your domain data in the volume is safe, and an
admin is re-bootstrapped each boot). **Local mode is unaffected** — it
auto-authenticates, no sessions. For durable OAuth sessions on a shared instance,
use **Postgres**.
:::
