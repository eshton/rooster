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

> Status: **early scaffolding** (v1 in progress). See the build phases below.

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
  server/      Hono app: REST/JSON API + MCP endpoint + auth + SSR dashboard   (phase 5–6)
  marketing/   Astro static marketing site                                     (phase 8)
  docs/        Astro Starlight documentation site                              (phase 8)
packages/
  schema/      Shared zod domain types + DTOs — source of truth for validation ✅
  config/      Env loading/validation (zod) + db-driver / platform selection   ✅
  db/          Drizzle schema + migrations + repositories + driver abstraction   ✅
  core/        Domain services, permission checks, audit logging                (phase 3)
  mcp/         MCP server (tools + resources) over Streamable HTTP              (phase 5)
  auth/        better-auth: human OAuth + MCP OAuth 2.1 (DCR/PKCE)              (phase 4)
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

## Build phases

1. **Scaffold monorepo** — workspace, `packages/{config,schema,db}`, tooling, CI ✅
2. **Data layer** — Drizzle schema, PG + SQLite migrations, repositories, seed ✅
3. **Core services** — CRUD + status transitions, permissions, audit logging
4. **Auth** — better-auth human OAuth + MCP OAuth 2.1 (DCR/PKCE), enrollment
5. **MCP server** — tools/resources over Streamable HTTP, `whoami`
6. **Dashboard** — minimal Hono SSR: orgs/teams/projects/tickets, agent registry, audit log
7. **Deploy adapters** — Vercel + Cloudflare + Docker
8. **Marketing + docs** — Astro site + Starlight docs

v1 = phases 1–6.

## License

[MIT](./LICENSE)
