# CLAUDE.md — working on Rooster

Orientation for an AI agent (or human) picking up Rooster. Read this first, then
`README.md` (overview) and `docs/SELF_HOSTING.md` (running it).

## What Rooster is

An **open-source project manager for software agents**. Humans and AI agents
share one domain (orgs → teams → projects → tickets), but **agents are
first-class principals**: they self-register, carry a stable audited identity,
declare what kind of agent they are, and act over **MCP**. Humans use OAuth
login (dashboard pending). Design priorities, in order: **secure-first**,
**agents-first**, **portable** (one codebase, Postgres _or_ SQLite, Node /
Vercel / Cloudflare).

## Status (what exists today)

Working, tested, committed:

- **Domain + persistence** — full schema, dual-dialect migrations, repositories.
- **Core services** — teams/projects/tickets/agents/comments/members/audit with
  permission checks, ticket status-transition rules, tags, parent/subtasks,
  and append-only audit logging on every mutation.
- **Auth** — better-auth as human OAuth login + the MCP OAuth 2.1 authorization
  server (Dynamic Client Registration + PKCE), plus the token/session → domain
  identity bridge and enrollment gating.
- **MCP server** — tools + resources over Streamable HTTP.
- **Server app** (`@rooster/server`) — Hono app mounting auth, the MCP endpoint,
  discovery/`llms.txt`, and gated agent-first tenant onboarding (`POST /onboard`).
- **Postgres** — `db:migrate` CLI; persistent better-auth on Postgres.

Not done yet (good next tasks):

1. **Vercel adapter** — `vercel.json` + a function entry wrapping the Hono app
   (Node runtime, because the pg pool needs Node). The app is already Web-
   standard `fetch`, so this is thin.
2. **Dashboard** — the human SSR UI (login, org/team/project/ticket views, agent
   registry, audit-log viewer). Nothing exists yet.
3. **Docker** — `Dockerfile` + `docker-compose.yml` (server + Postgres).
4. **Marketing + docs sites** — Astro + Starlight (plan phase 8).
5. **MCP-over-HTTP clientInfo capture** — the audit snapshot is wired through the
   actor but the HTTP `/mcp` route currently passes `clientInfo: null`; capturing
   the MCP `initialize` clientInfo would complete it.

**The north-star milestone:** deploy to Vercel + Postgres, then connect Claude
Code's MCP client to the deployed `/mcp` so Rooster tracks its own development.

## Monorepo map

```
packages/
  config/   env loading + validation (zod), db-driver + platform selection
  schema/   zod domain entities, enums, DTOs, ids — the validation source of truth
  db/       Drizzle schema (sqlite + pg), migrations, repositories, drivers, seed
  core/     domain services, permissions, status transitions, audit, onboarding
  auth/     better-auth config, identity bridge, enrollment gating, scopes
  mcp/      MCP server: tools + resources + stateless Streamable-HTTP transport
apps/
  server/   the deployable Hono app (auth + /mcp + discovery + /onboard) + Node entry
```

Dependency direction (never cycle): `config` ← `db` ← `core` ← {`auth`, `mcp`}
← `server`. `schema` is depended on by everyone. **Core depends only on db +
schema** (transport-agnostic). Auth depends on core (for the actor types).

## The request → action flow (how it all connects)

1. Agent authenticates via OAuth (DCR + PKCE); sends `Authorization: Bearer …`
   to `POST /mcp`.
2. `apps/server` → `auth.resolveMcpIdentity()` validates the token
   (`auth.api.getMcpSession`) and maps `clientId` → bound **Agent** →
   `ActorIdentity` (effective scopes = token grant ∩ agent allowance).
3. `core.resolveActor(identity)` loads the principal + computes the effective
   org role from memberships → an **Actor** `{ orgId, principalId, type, role,
   scopes, clientInfo }`.
4. A per-request `McpServer` is built bound to that Actor; the tool calls a core
   service.
5. Every core mutation: `authorize(actor, permission)` (role floor **and**, for
   agents, token scope) → validate input with the schema DTO → enforce `orgId`
   scoping in the repository → write the row → append an **audit** record
   attributed to the trusted `principalId` (with the untrusted `clientInfo`
   snapshot).

Security model in one line: **agents need both a sufficient role and the token
scope; humans are governed by role alone; `clientInfo` is display-only, never
authorization.**

## Conventions

- TypeScript, ESM, `NodeNext` resolution → **import local files with `.js`**
  extensions. Node ≥ 20, `pnpm@10`. Packages are `@rooster/*`, `workspace:*`.
- **Biome** for lint + format (single quotes, no semicolons, 100 cols, trailing
  commas). `noNonNullAssertion` is off (see `biome.json`).
- **Vitest**; workspace packages are aliased to their `src` in `vitest.config.ts`
  so tests run without a prior build.
- `tsc -b` project references; each package has its own `tsconfig.json` and is
  registered in the root `tsconfig.json`.

### Database portability (important)

One repository implementation (`packages/db/src/repositories/impl.ts`) serves
**both** dialects. This works because the two Drizzle schemas
(`schema/sqlite.ts`, `schema/pg.ts`) are kept **structurally identical**:
- ids and timestamps are **TEXT** (app-generated UUIDs via `crypto.randomUUID()`;
  ISO-8601 strings),
- arrays / JSON (labels, scopes, audit before/after, clientInfo) are **TEXT**
  (JSON-encoded in the repo),
- booleans are normalized to JS booleans.

The Postgres driver passes its drizzle instance + pg schema through a **single
type-bridge** (`as unknown as` in `drivers/postgres.ts`) into the libSQL-typed
factory. If you change one dialect schema, change the other identically and
regenerate both migrations.

## Commands

```bash
pnpm install
pnpm build            # tsc -b (all packages)
pnpm test             # vitest run  (71 tests today; in-memory SQLite)
pnpm lint             # biome check
pnpm check            # lint + build + test  ← run before every commit

# db (packages/db)
pnpm --filter @rooster/db db:generate:sqlite   # regenerate after schema edits
pnpm --filter @rooster/db db:generate:pg
pnpm --filter @rooster/db db:migrate           # apply migrations for DATABASE_URL
pnpm --filter @rooster/db db:seed              # demo data (after build)

# server
pnpm --filter @rooster/server start            # node, auto-migrates domain tables
pnpm --filter @rooster/server auth:migrate     # better-auth's own tables (Postgres)
```

Local smoke (no Postgres needed): set `DATABASE_URL=file:./local.db`,
`ROOSTER_AUTH_SECRET=$(openssl rand -base64 32)`, then `start` and curl
`/.well-known/rooster`, `/llms.txt`, `POST /onboard`.

## How to make common changes

- **Add a ticket field**: edit both `schema/{sqlite,pg}.ts` identically →
  `db:generate:sqlite` + `db:generate:pg` → update the entity in
  `packages/schema/src/entities.ts` (+ DTO if user-supplied) → map it in
  `repositories/impl.ts` → thread through the relevant core service.
- **Add an MCP tool**: add the method to the core service (with `authorize` +
  audit), then register it in `packages/mcp/src/tools.ts` (reuse the DTO `.shape`
  for `inputSchema`). Add an end-to-end case in `mcp.test.ts`.
- **Add a permission/scope**: extend `Permission` + `PERMISSION_MIN_ROLE` in
  `packages/core/src/permissions.ts`; it automatically becomes a grantable OAuth
  scope (`ROOSTER_SCOPES` derives from it).

## Gotchas (things that cost time)

- **In-memory SQLite tests** use `DATABASE_URL=file::memory:`, mapped to
  libSQL `:memory:` in `drivers/libsql.ts`. libSQL `transaction()` opens a
  separate connection there, so the migrated tables vanish inside a transaction
  — that's why `nextNumber` uses an atomic `UPDATE … RETURNING` instead of a
  read-then-write transaction. Avoid transactions that span the in-memory case.
- **better-auth's instance type is not portable** across `.d.ts` emit, so
  `@rooster/auth` exposes an explicit `RoosterAuth` interface and casts once at
  the boundary (`auth.ts`). Don't try to re-export the inferred type.
- **Auth storage**: memory adapter for dev/sqlite/tests (NOT durable on
  serverless); a real `pg.Pool` when `DATABASE_URL` is Postgres. better-auth owns
  its tables — apply them with `auth:migrate` (see `docs/SELF_HOSTING.md`).
- **Onboarding gate** lives in the transport (`apps/server/src/gate.ts` +
  `ROOSTER_SIGNUP_TOKEN`), not in core — `provisionTenant` is pure provisioning.

## Verification expectations

`pnpm check` must be green before any commit. Tests run against in-memory
SQLite; the MCP layer is tested with a real `Client` over `InMemoryTransport`;
the OAuth server is exercised through the better-auth memory adapter. The
Postgres + Vercel paths are built production-shaped but are first exercised on a
real deploy (no Postgres/Vercel in CI yet) — call that out, don't claim it's
verified.

## Git

Work has been developed on `claude/tender-heisenberg-fp3gh3` and merged to
`main`. Branch for new work; run `pnpm check` before committing.
