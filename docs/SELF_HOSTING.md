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

   > **Upgrading across the project-key change (migration 0007):** the ticket
   > prefix moved from teams to projects, and ticket numbering is now per
   > project. Migration 0007 adds `projects.key` (nullable) + `projects.ticket_seq`
   > but **cannot backfill them** — a fresh install is fine, but an existing
   > database needs a one-time data fix (until a project has a non-null `key`,
   > tickets can't be filed in it). Run the bundled backfill once, after
   > `db:migrate`:
   >
   > ```bash
   > # preview the plan first (writes nothing):
   > DRY_RUN=1 DATABASE_URL=… pnpm --filter @rooster/db db:backfill-project-keys
   >
   > # pin keys per project (by name or id), or omit to auto-derive:
   > ROOSTER_PROJECT_KEYS='{"Rooster":"ROOST","astonagent":"ASA"}' \
   >   DATABASE_URL=… pnpm --filter @rooster/db db:backfill-project-keys
   > ```
   >
   > It assigns each keyless project a unique 3–5 char key and advances its
   > `ticket_seq` past any existing ticket that shares the new prefix, so reusing
   > a project's old prefix continues its numbering while a fresh key starts at 1.
   > Idempotent — already-keyed projects are skipped.

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

### Docker Compose (server + Postgres)

The quickest real (Postgres-backed) instance:

```bash
ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) docker compose up --build
```

The server auto-migrates the **domain** tables on boot. Then, once, create
better-auth's tables (it owns them on Postgres):

```bash
docker compose exec server pnpm --filter @rooster/server auth:migrate
```

The compose file lives at the repo root; the image is built from
`apps/server/Dockerfile`. Set `ROOSTER_SIGNUP_TOKEN` in the `server` service to
gate tenant registration.

### Other targets

- **Node / VPS** — `pnpm --filter @rooster/server start` (auto-migrates domain
  tables on boot). Persistent auth works out of the box on Postgres.
- **Vercel** — deploy the Hono app as a function. Run `db:migrate` and
  `auth:migrate` as a one-off (e.g. a deploy hook), not on cold start. Use a
  hosted Postgres (Neon / Vercel Postgres) for `DATABASE_URL`. The in-memory
  auth adapter is NOT used for Postgres deploys — better-auth uses a real pool.

### Cloudflare Workers (Turso)

Workers can't run `pg` or the native libSQL client, so the edge build uses
**libSQL/Turso over HTTP** — one connection serves both the domain repositories
and better-auth (via its drizzle adapter, with the committed
`apps/server/src/auth-schema.ts`). The entry is `apps/server/src/worker.ts`;
config is in `apps/server/wrangler.toml` (note
`compatibility_flags = ["nodejs_compat"]`, required for `node:crypto`).

1. Create a Turso database and get its `libsql://…` URL + auth token.
2. Migrate **both** sets of tables from Node/CI (the Worker never migrates at
   runtime). The libSQL `auth:migrate` creates better-auth's tables with the
   exact camelCase names the runtime drizzle adapter expects:
   ```bash
   export DATABASE_URL=libsql://YOUR-DB.turso.io DATABASE_AUTH_TOKEN=…
   pnpm --filter @rooster/db db:migrate          # domain tables
   pnpm --filter @rooster/server auth:migrate    # better-auth tables
   ```
3. Set secrets and deploy:
   ```bash
   cd apps/server
   pnpm dlx wrangler@4 secret put ROOSTER_AUTH_SECRET
   pnpm dlx wrangler@4 secret put DATABASE_AUTH_TOKEN
   # set DATABASE_URL + ROOSTER_BASE_URL as vars (wrangler.toml [vars] or dashboard)
   pnpm --filter @rooster/server deploy:worker
   ```

> **Status:** the auth flow is verified — `auth:migrate` against libSQL plus the
> runtime drizzle adapter (sign-up + session) was exercised against a real
> libSQL database. What remains unexercised here is only the live Cloudflare
> Workers runtime itself and Turso-over-HTTP (no Workers/Turso in the build
> sandbox). Node/Docker and Vercel remain fully verified end to end.
>
> If you ever regenerate `auth-schema.ts` (e.g. after a better-auth upgrade),
> keep its table/column names **camelCase** to match `auth:migrate` — see the
> note at the top of that file.

### Continuous deploy (GitHub Actions → Cloudflare)

`ci.yml` auto-deploys on push to `main`, gated on the full verify matrix passing
(`needs:` the lint/build/test, Postgres, migration-drift, and Worker-bundle
jobs). The `deploy-server` job migrates Turso (`db:migrate` then `auth:migrate`)
and `wrangler deploy`s the Worker, then post-deploy smoke-tests
`/healthz`, `/.well-known/rooster` (asserting the base URL),
`/llms.txt`, and the OAuth discovery aliases. `deploy-sites` builds + deploys the
marketing/docs Pages bundle. Both run under the `production` GitHub Environment
(add branch/approval protection there).

Configure the **production** Environment:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Workers + Pages deploy token |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| Secret | `DATABASE_URL` | `libsql://<db>.turso.io` |
| Secret | `DATABASE_AUTH_TOKEN` | Turso token |
| Secret | `ROOSTER_AUTH_SECRET` | 32-byte random (must match the Worker's) |
| Variable | `CLOUDFLARE_PAGES_PROJECT` | the Pages project name |

If a secret is missing the deploy job fails at its step; the verify matrix is
unaffected. The base URL is pinned to `https://app.airooster.dev` in the job env
— change it there and in `wrangler.toml [vars]` together.

> **Rate limiting:** the per-agent MCP rate limit
> (`ROOSTER_MCP_RATE_LIMIT_PER_MINUTE`) is backed by a shared `rate_limits`
> table (a single atomic upsert per request), so it limits correctly across
> instances on serverless/edge as well as on a single Node/Docker server.

> **Transactional email (password reset):** email/password accounts need a way
> to deliver reset links. Rooster picks a sender in priority order — **Resend**
> → **webhook** → **stdout** — so configure one for production:
>
> - **Resend** (recommended; edge-friendly, just HTTP): set `RESEND_API_KEY` and
>   `ROOSTER_EMAIL_FROM` (e.g. `Rooster <no-reply@your-domain>`). The sending
>   domain must be verified in Resend (DNS) for mail to be delivered.
> - **Webhook**: set `ROOSTER_EMAIL_WEBHOOK_URL`; Rooster POSTs
>   `{type:'email', to, subject, text, kind, url}` to your endpoint to deliver.
> - **Neither**: the reset link is logged to stdout — fine for local/self-host,
>   not for production.
>
> Email verification is intentionally **not** required to sign in (enabling it
> without a configured sender would lock users out).

## 5a. Self-host quickstart: first-run admin (the "just me" path)

For a personal or internal instance you don't need the OAuth/MCP onboarding
dance or any email setup. Set an admin and (optionally) close public sign-up:

```bash
ROOSTER_ADMIN_EMAIL=you@example.com
ROOSTER_ADMIN_PASSWORD=at-least-8-chars
ROOSTER_ADMIN_WORKSPACE="My Workspace"   # optional (default "My Workspace")
ROOSTER_ADMIN_PROJECT_KEY=TASK           # optional (default "TASK")
ROOSTER_DISABLE_SIGNUP=true              # optional: invite-only instance
```

On startup the Node entry (`pnpm --filter @rooster/server start`) creates the
account + a starter workspace if that email has no Rooster user yet — idempotent,
so it's a no-op on later boots. Then just open `/app/login` and sign in. No email
delivery, no sign-up form, no MCP required.

- `ROOSTER_DISABLE_SIGNUP=true` rejects public email/password sign-up
  (`POST /api/auth/sign-up/email` → 403) and hides the dashboard's create-account
  link; new members join only by **invite** (see the dashboard Members page).
  Social login is governed separately by which OAuth providers you configure.
- The admin bootstrap runs even when sign-up is disabled (it's a server-side
  call, not the public HTTP route).
- It runs on the **Node** entry. On serverless/edge, provision via `/onboard`
  (below) or seed the DB instead.

## 5b. Onboard the first tenant (agent-first)

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

## 6. Public roadmap (optional)

Expose one project's tickets as a public, unauthenticated roadmap at `/roadmap`,
rendered server-side straight from the database and **sorted by priority**
(canceled tickets omitted). It's opt-in: nominate the workspace and project to
publish.

```bash
ROOSTER_ROADMAP_ORG_SLUG=rooster-dev    # the workspace slug
ROOSTER_ROADMAP_PROJECT_KEY=ROO         # the project's ticket-key prefix
ROOSTER_ROADMAP_TITLE="Rooster roadmap" # optional heading override
```

Both the slug and the key must be set together (set only one and startup fails
fast). With neither set, `/roadmap` returns 404 and the landing page omits the
link. The page always reflects the live board — no rebuild or sync step — and is
read-only: it bypasses the per-actor permission layer precisely because you've
designated that single project public, and reads nothing else.
