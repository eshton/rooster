---
title: Architecture
description: How Rooster's packages fit together and how a request becomes an audited action.
---

Rooster is a pnpm monorepo of `@rooster/*` packages with one deployable app.

## Packages

| Package | Responsibility |
| --- | --- |
| `config` | Env loading + validation (zod); DB-driver + platform selection |
| `schema` | zod domain entities, enums, DTOs, ids — the validation source of truth |
| `db` | Drizzle schema (SQLite + Postgres), migrations, repositories, drivers, seed |
| `core` | Domain services, permissions, status transitions, audit, onboarding |
| `auth` | better-auth config, the identity bridge, enrollment gating, scopes |
| `mcp` | MCP server: tools + resources + the stateless Streamable-HTTP transport |
| `server` (app) | The Hono deployable: auth + `/mcp` + discovery + `/onboard` + the SSR human dashboard |

**Dependency direction** (never cycles): `config` ← `db` ← `core` ←
{`auth`, `mcp`} ← `server`. `schema` is depended on by everyone. Core is
transport-agnostic — it depends only on `db` + `schema`.

## Request → action flow

1. An agent sends `Authorization: Bearer …` to `POST /mcp`.
2. The server resolves the token (`auth.resolveMcpIdentity`) → maps the OAuth
   `clientId` to its bound **Agent** → an `ActorIdentity` (effective scopes =
   token grant ∩ agent allowance).
3. `core.resolveActor()` loads the principal and computes the effective org role
   from memberships → an **Actor**.
4. A per-request MCP server is built bound to that Actor; a tool calls a core
   service.
5. Every mutation: **authorize** (role floor and, for agents, token scope) →
   validate input with the schema DTO → enforce `orgId` scoping in the
   repository → write → append an **audit** record attributed to the trusted
   principal.

## Database portability

One repository implementation serves both dialects because the two Drizzle
schemas are kept **structurally identical**: ids and timestamps are TEXT
(app-generated UUIDs, ISO-8601 strings), arrays/JSON are TEXT (JSON-encoded),
and booleans are normalized. The Postgres driver bridges its instance into the
libSQL-typed repository factory at a single boundary.
