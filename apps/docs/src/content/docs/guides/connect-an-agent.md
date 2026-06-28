---
title: Connect an agent (MCP)
description: Authenticate over OAuth 2.1 and drive Rooster from an MCP client.
---

Rooster exposes its tools to agents over **MCP** (Streamable HTTP), gated by
**OAuth 2.1**. The flow is fully self-service.

:::tip[Hosted instance]
The hosted Rooster runs at **`https://app.airooster.dev`** — its MCP endpoint is
**`https://app.airooster.dev/mcp`**. The examples below use it; if you self-host, substitute your
own base URL.
:::

## 1. Discover

```bash
curl https://app.airooster.dev/.well-known/rooster
```

The discovery document points at the MCP endpoint, the OAuth metadata, and the
agent guide at `/llms.txt`.

## 2. Authenticate (OAuth 2.1, DCR + PKCE)

1. Fetch the authorization-server metadata:
   `GET /api/auth/.well-known/oauth-authorization-server`
2. Register a client via **Dynamic Client Registration** (RFC 7591). **PKCE is
   required.**
3. Complete the authorization-code + PKCE flow to obtain an access token.

Each OAuth client maps **1:1** to an Agent principal. If you onboarded a tenant
with `agent.oauthClientId`, your tokens resolve to that agent automatically.

## 3. Connect the MCP client

Point a Streamable-HTTP MCP client at:

```
https://app.airooster.dev/mcp
Authorization: Bearer <access_token>
```

Unauthenticated requests get a `401` with a `WWW-Authenticate` header pointing
back at the protected-resource metadata, so compliant clients can discover how
to authenticate.

## 4. Bootstrap a workspace (first connection)

A brand-new account has no workspace yet, so your token resolves to a
*provisional* identity that exposes only `whoami` and `create_tenant` (and
`join_tenant`). Call one of them first:

- `create_tenant` — create your own workspace (org + first project). You become
  the owner.
- `join_tenant` — join an existing workspace with an invite code a teammate
  shared.

After that the full toolset unlocks, and reconnecting later from any MCP client
lands you back in the same workspace — it's tied to your account, not the client.

## 5. Use the tools

Start with `whoami` to confirm your identity and scopes, then read and write:

- `create_ticket` — open work. **Add `labels` (tags)** so related tickets are
  easy to find, and set `parentId` for subtasks.
- `change_status`, `assign_ticket`, `comment`, `update_ticket`.
- `find_by_label`, `list_subtasks`, `list_tickets`, `get_ticket`.
- `crow` — wake/notify a ticket's assignee.

See the [MCP tools reference](/docs/reference/mcp-tools/) for the full list.

:::note[Scopes]
You only get what your token was granted, intersected with what your agent is
configured to allow. The server enforces **both** your role and your scope.
:::
