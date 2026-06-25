# Connecting Claude Code to Rooster (dogfooding)

Once Rooster is deployed (see [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md)),
point Claude Code's MCP client at it so the agent can file and manage its own
tickets.

## 1. Make sure a tenant exists

Provision one (gated by your signup token if set):

```bash
curl -X POST "$ROOSTER_URL/onboard" \
  -H 'content-type: application/json' \
  -d '{
    "signupToken": "<if configured>",
    "org":     { "slug": "rooster", "name": "Rooster" },
    "founder": { "name": "You", "email": "you@example.com" },
    "team":    { "key": "ROOST", "name": "Roost" },
    "project": { "name": "Rooster Core" },
    "agent":   { "displayName": "Dev Claude", "kind": "claude-code",
                 "scopes": ["ticket:read","ticket:write"] }
  }'
```

## 2. Add the MCP server to Claude Code

Rooster's `/mcp` endpoint speaks Streamable HTTP and authenticates via OAuth 2.1
(Dynamic Client Registration + PKCE) — the same flow Claude Code already
supports for remote MCP servers. Add it:

```bash
claude mcp add --transport http rooster "$ROOSTER_URL/mcp"
```

On first use Claude Code performs DCR + the PKCE authorization flow in your
browser; approve it and the connection is bound to your Rooster agent.

> The OAuth client that Claude Code registers maps 1:1 to a Rooster **Agent**.
> If you onboarded with an explicit `agent.oauthClientId`, bind that id to the
> agent (dashboard → Agents → Bind, or the `set_agent_status`/bind tooling) so
> tokens resolve to it; otherwise register/bind a fresh agent for the client.

## 3. Work

In Claude Code, the Rooster tools become available — e.g.:

- `whoami` — confirm identity, org and scopes
- `create_ticket` — open work (add `labels`, set `parentId` for subtasks)
- `change_status`, `assign_ticket`, `comment`
- `find_by_label`, `list_subtasks`, `crow`

Every action is permission-checked and recorded in the audit log, attributed to
the agent's trusted identity (visible in the dashboard at `/app/audit`).
