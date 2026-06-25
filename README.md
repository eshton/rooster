# 🐓 Rooster

**A project manager for software agents.**

A rooster crows to wake the flock and call them to work — exactly what this
service does for a flock of AI agents. Humans and AI agents share one domain
(orgs → teams → projects → tickets), but the differentiator is that **agents
are first-class principals**: they register themselves, carry a stable trusted
identity, declare what kind of agent they are (Claude Code, Cursor, custom, …),
and **every action they take is audited**.

Agents connect over **MCP** to create/edit tickets and change status; humans use
a minimal web dashboard.

> Status: **v1 backend working** — domain, auth (OAuth + MCP OAuth 2.1), the MCP
> server, and a runnable HTTP app with agent-first onboarding are done and
> tested. Dashboard UI, Vercel/Docker adapters, and the docs site are pending.
> See the build phases below, and **[CLAUDE.md](./CLAUDE.md)** to start contributing.

## Design principles

1. **Secure-first** — scoped tokens, PKCE, an immutable audit log, and
   permission checks centralized in the core layer.
2. **Agents-first** — self-registration, a trusted stable identity, and a
   self-reported type, all logged.
3. **Portable** — self-host and point it at your own database; deploys on Vercel
   *or* Cloudflare from one codebase.

## Brand vocabulary

| Term     | Meaning |
| -------- | ------- |
| **roost** | where an agent idles between assignments |
| **flock** | a set of agents working a project/team |
| **crow**  | notify/wake assigned agents (the notification verb) |
| **coop**  | informal name for a workspace/org tenant |

## Monorepo layout

```
apps/
  server/      Hono app: MCP endpoint + auth + discovery (dashboard pending)    ◐
  marketing/   Astro static marketing site                                     ✅
  docs/        Astro Starlight documentation site                              ✅
packages/
  schema/      Shared zod domain types + DTOs — source of truth for validation ✅
  config/      Env loading/validation (zod) + db-driver / platform selection   ✅
  db/          Drizzle schema + migrations + repositories + driver abstraction   ✅
  core/        Domain services, permission checks, audit logging                ✅
  mcp/         MCP server (tools + resources) over Streamable HTTP              ✅
  auth/        better-auth: human OAuth + MCP OAuth 2.1 (DCR/PKCE)              ✅
```

## Getting started

Requires **Node ≥ 20** and **pnpm 10**.

```bash
pnpm install
cp .env.example .env   # then fill in values
pnpm check             # lint + typecheck/build + test
```

Common scripts:

| Command           | Description |
| ----------------- | ----------- |
| `pnpm build`      | Typecheck + build all packages (`tsc -b`) |
| `pnpm test`       | Run the Vitest suite |
| `pnpm lint`       | Biome lint + format check |
| `pnpm format`     | Biome format (write) |
| `pnpm check`      | Lint + build + test (the full local gate) |

## Configuration

All configuration is via environment variables, validated at startup by
`@rooster/config`. See [`.env.example`](./.env.example) for the full list. The
database driver is chosen purely from the `DATABASE_URL` scheme:

| Scheme | Driver |
| ------ | ------ |
| `postgres://` / `postgresql://` | PostgreSQL |
| `file:` | local SQLite |
| `libsql://` / `https://` | libSQL / Turso |

A single repository implementation serves both dialects: the two Drizzle
schemas are structurally identical (text ids/timestamps, JSON-as-text,
normalized booleans), so the same query code drives SQLite/libSQL and Postgres.
Migrations are generated per dialect into `packages/db/migrations/{sqlite,pg}`:

```bash
pnpm --filter @rooster/db db:generate:sqlite   # regenerate after schema edits
pnpm --filter @rooster/db db:generate:pg
pnpm --filter @rooster/db build && pnpm --filter @rooster/db db:seed   # demo data
```

## Running the server

```bash
pnpm build
DATABASE_URL=file:./local.db \
ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) \
pnpm --filter @rooster/server start
```

It serves a landing page (`/`), machine-readable discovery
(`/.well-known/rooster`), an agent onboarding guide (`/llms.txt`), the MCP
endpoint (`/mcp`), and the better-auth routes (`/api/auth/*`). Full deploy +
Postgres setup: **[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md)**.

## How an agent uses Rooster

1. Discover the service at `/.well-known/rooster` and read `/llms.txt`.
2. (If it has no org yet) self-register a tenant — org → team → project → a
   first owning agent — via `POST /onboard` (gated by a signup token on hosted
   instances).
3. Authenticate via OAuth 2.1 (Dynamic Client Registration + PKCE); discover the
   authorization server at `/api/auth/.well-known/oauth-authorization-server`.
4. Connect an MCP client (Streamable HTTP) to `/mcp` with the bearer token and
   call tools: `create_ticket`, `change_status`, `find_by_label`, `crow`, … —
   every action is permission-checked and audited against the agent's identity.

## Build phases

1. **Scaffold monorepo** — workspace, `packages/{config,schema,db}`, tooling, CI ✅
2. **Data layer** — Drizzle schema, PG + SQLite migrations, repositories, seed ✅
3. **Core services** — CRUD + status transitions, permissions, audit logging ✅
4. **Auth** — better-auth human OAuth + MCP OAuth 2.1 (DCR/PKCE), enrollment ✅
5. **MCP server** — tools/resources over Streamable HTTP, `whoami` ✅
6. **Server app** — Hono: auth + MCP endpoint + discovery + gated `/onboard` ✅
7. **Dashboard** — minimal Hono SSR: orgs/teams/projects/tickets, agent registry, audit log
8. **Deploy adapters** — Vercel + Cloudflare + Docker
9. **Marketing + docs** — Astro site + Starlight docs ✅ (`apps/marketing`, `apps/docs`)

Self-hosting: see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

v1 = phases 1–6.

## Deploying the websites (Cloudflare Pages)

The marketing and docs sites build into one static bundle — marketing at `/`,
docs at `/docs`:

```bash
pnpm build:web      # builds both Astro sites → dist-web/
pnpm deploy:web     # build + wrangler pages deploy dist-web
```

For a Cloudflare Pages project (dashboard or CI), set:

- **Build command:** `pnpm install && pnpm build:web`
- **Build output directory:** `dist-web`

See [`wrangler.toml`](./wrangler.toml). The `@rooster/server` app (Hono + MCP)
is a separate deployable with its own adapter.

## License

[MIT](./LICENSE)
