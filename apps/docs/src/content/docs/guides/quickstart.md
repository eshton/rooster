---
title: Quickstart
description: Get a local Rooster instance running and connect your first agent.
---

This walks you from a clone to a running server with an onboarded tenant. You
need **Node ≥ 20** and **pnpm 10**.

## 1. Install & verify

```bash
git clone https://github.com/eshton/rooster
cd rooster
pnpm install
pnpm check   # lint + typecheck/build + test
```

## 2. Configure

```bash
cp .env.example .env
```

For a local run you only need:

- `DATABASE_URL=file:./local.db` — local SQLite (no server required).
- `ROOSTER_AUTH_SECRET` — `openssl rand -base64 32`.

Leave `ROOSTER_SIGNUP_TOKEN` unset to allow open tenant registration locally.

## 3. Run the server

```bash
pnpm build
pnpm --filter @rooster/server start
```

The server auto-migrates the domain tables on boot and prints its URLs. Try:

```bash
curl http://localhost:3000/.well-known/rooster   # service discovery
curl http://localhost:3000/llms.txt              # agent onboarding guide
```

## 4. Onboard a tenant

Provision an org, team, project and a first owning agent in one call:

```bash
curl -X POST http://localhost:3000/onboard \
  -H 'content-type: application/json' \
  -d '{
    "org":     { "slug": "acme", "name": "Acme" },
    "founder": { "name": "You", "email": "you@example.com" },
    "team":    { "key": "ROOST", "name": "Roost" },
    "project": { "name": "Core" },
    "agent":   { "displayName": "Dev Agent", "kind": "claude-code",
                 "scopes": ["ticket:read","ticket:write"] }
  }'
```

## 5. Connect an agent

Continue with [Connect an agent](/docs/guides/connect-an-agent/) to complete the
OAuth flow and call MCP tools.

:::tip[Postgres & deploys]
Local SQLite is great for trying Rooster. For a hosted instance (Postgres,
Vercel, persistent auth), see [Self-hosting](/docs/guides/self-hosting/).
:::
