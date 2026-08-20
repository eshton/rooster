---
title: Quickstart
description: Get a Rooster instance running and connect your first agent — in one command.
---

Three ways to start, fastest first. For a single user on your own machine, the
Docker path takes about a minute.

## Fastest: run it locally with Docker

No clone, no build, no database. **Local mode** skips the OAuth dance — your
agent connects with one static token and the dashboard signs you in
automatically. Bound to `127.0.0.1`.

```bash
docker run -p 127.0.0.1:3000:3000 -v rooster-data:/data \
  -e ROOSTER_LOCAL_MODE=1 \
  -e ROOSTER_LOCAL_TOKEN=$(openssl rand -base64 24) \
  -e ROOSTER_AUTH_SECRET=$(openssl rand -base64 32) \
  ghcr.io/eshton/rooster:latest
```

On first boot it creates your owner account and a starter workspace. Then:

- Open **http://localhost:3000/app** — you're already signed in.
- Point your MCP client (Claude Code, opencode, Cursor, …) at
  `http://localhost:3000/mcp` with header
  `Authorization: Bearer <ROOSTER_LOCAL_TOKEN>`.

Your tickets and CRM data persist in the `rooster-data` volume. Compose
equivalent: `docker compose -f docker-compose.local.yml up`.

:::caution[Local mode is single-user, token-only auth]
It's bound to `127.0.0.1` and the server **refuses to run it on a public URL**.
For a shared or internet-facing instance, use OAuth login instead — see
[Self-hosting](/docs/guides/self-hosting/).
:::

## Or: use the hosted instance

Don't want to run anything? Point an agent at the live instance and let it
onboard you:

- Agent guide: <https://app.airooster.dev/llms.txt>
- Service discovery: <https://app.airooster.dev/.well-known/rooster>

Your agent reads `/llms.txt`, connects over OAuth (one browser sign-in), then
calls `create_tenant` to bootstrap your workspace. See
[Connect an agent](/docs/guides/connect-an-agent/).

## Or: from source (for development)

To hack on Rooster itself. You need **Node ≥ 20** and **pnpm 10**.

```bash
git clone https://github.com/eshton/rooster
cd rooster
pnpm install
pnpm check   # lint + typecheck/build + test
```

Configure a local SQLite DB and a secret, then run:

```bash
echo 'DATABASE_URL=file:./local.db' >> .env
echo "ROOSTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
pnpm build
pnpm --filter @rooster/server start
```

The server auto-migrates the domain tables on boot and prints its URLs. Check
service discovery and the agent guide:

```bash
curl http://localhost:3000/.well-known/rooster
curl http://localhost:3000/llms.txt
```

Then connect an agent (OAuth), or provision a tenant directly over HTTP:

```bash
curl -X POST http://localhost:3000/onboard \
  -H 'content-type: application/json' \
  -d '{
    "org":     { "slug": "acme", "name": "Acme" },
    "founder": { "name": "You", "email": "you@example.com" },
    "team":    { "key": "ROOST", "name": "Roost" },
    "project": { "name": "Core" }
  }'
```

## Next

Complete the OAuth flow and call MCP tools in
[Connect an agent](/docs/guides/connect-an-agent/), or run a real instance in
[Self-hosting](/docs/guides/self-hosting/).
