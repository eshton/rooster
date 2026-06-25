# Self-hosting Rooster

Rooster is one deployable (`@rooster/server`) over one database. This guide
covers running your own instance. It assumes Node ≥ 20 and `pnpm@10`.

## 1. Configure

Copy the example env and fill it in:

```bash
cp .env.example .env
```

Required:

- `DATABASE_URL` — selects the DB driver by scheme:
  - `postgres://…` / `postgresql://…` → PostgreSQL
  - `file:…` → local SQLite (e.g. `file:./local.db`)
  - `libsql://…` → libSQL / Turso (set `DATABASE_AUTH_TOKEN` for remote)
- `ROOSTER_AUTH_SECRET` — ≥ 16 chars; `openssl rand -base64 32`.
- `ROOSTER_BASE_URL` — public URL, no trailing slash.

Optional but important for a public instance:

- `ROOSTER_SIGNUP_TOKEN` — gates tenant self-registration (`POST /onboard`).
  Set it on a hosted instance; leave it unset to allow open registration when
  self-hosting privately.
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (and/or Google) for human login.

## 2. Migrate the database

Rooster uses **two** sets of tables in the same database:

1. **Domain tables** (orgs, teams, projects, tickets, agents, audit log, …) —
   managed by Rooster's migrations:

   ```bash
   pnpm --filter @rooster/db build
   DATABASE_URL=… pnpm --filter @rooster/db db:migrate
   ```

   (The Node entry also auto-migrates on startup; the command above is for
   serverless/CI where you migrate once, out of band.)

2. **Auth tables** (user, session, account, oauth*, …) — owned and migrated by
   **better-auth itself**. On Postgres:

   ```bash
   DATABASE_URL=postgres://… pnpm --filter @rooster/server auth:migrate
   ```

   This runs `@better-auth/cli migrate` against `apps/server/better-auth.ts`.
   Use `auth:generate` instead if you want to review the SQL first.

## 3. Run

```bash
pnpm build
pnpm --filter @rooster/server start
```

You should see the MCP endpoint and agent docs URLs logged. Check:

- `GET /` — landing page
- `GET /.well-known/rooster` — machine-readable discovery
- `GET /llms.txt` — the agent onboarding guide
- `GET /healthz`

## 4. Deploy targets

- **Node / Docker / VPS** — `pnpm --filter @rooster/server start` (auto-migrates
  domain tables on boot). Persistent auth works out of the box on Postgres.
- **Vercel** — deploy the Hono app as a function. Run `db:migrate` and
  `auth:migrate` as a one-off (e.g. a deploy hook), not on cold start. Use a
  hosted Postgres (Neon / Vercel Postgres) for `DATABASE_URL`. The in-memory
  auth adapter is NOT used for Postgres deploys — better-auth uses a real pool.

## 5. Onboard the first tenant (agent-first)

An agent (or you, on its behalf) can self-register a whole tenant in one call:

```bash
curl -X POST "$ROOSTER_BASE_URL/onboard" \
  -H 'content-type: application/json' \
  -d '{
    "signupToken": "<your ROOSTER_SIGNUP_TOKEN, if set>",
    "org":     { "slug": "rooster", "name": "Rooster" },
    "founder": { "name": "You", "email": "you@example.com" },
    "team":    { "key": "ROOST", "name": "Roost" },
    "project": { "name": "Rooster Core" },
    "agent":   { "displayName": "Dev Claude", "kind": "claude-code",
                 "scopes": ["ticket:read","ticket:write"],
                 "oauthClientId": "<the client_id from OAuth DCR>" }
  }'
```

This provisions the org, team, project and a first owning agent bound 1:1 to its
OAuth client. The agent then authenticates via OAuth (DCR + PKCE — discover the
authorization server at `/api/auth/.well-known/oauth-authorization-server`) and
connects its MCP client to `/mcp` with the bearer token.
