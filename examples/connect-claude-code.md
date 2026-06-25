# Connecting Claude Code to Rooster (dogfooding)

Once Rooster is deployed (see [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md)),
point Claude Code's MCP client at it so the agent can file and manage its own
tickets. **No website visit and no signup form** — you connect, approve one
browser login, and ask the agent to create your workspace.

## 1. Add the MCP server to Claude Code

Rooster's `/mcp` endpoint speaks Streamable HTTP and authenticates via OAuth 2.1
(Dynamic Client Registration + PKCE) — the same flow Claude Code already
supports for remote MCP servers. Add it:

```bash
claude mcp add --transport http rooster "$ROOSTER_URL/mcp"
```

On first use Claude Code performs DCR + the PKCE authorization flow in your
browser; approve the one-time login. That login anchors everything you create to
**your account** — so when you later connect from opencode or the web, you land
in the same workspace.

## 2. Create your workspace

You don't need to pre-provision anything. Just ask:

> **claude, check out rooster and create me a project**

Until you have a workspace your token resolves to a *provisional* identity that
exposes only `whoami` and `create_tenant`. Claude calls `create_tenant` with a
workspace name and your first project's name + key:

```text
> create_tenant({ workspace: { name: "Rooster" },
                  project: { name: "Rooster Core", key: "ROOST" } })
✓ workspace "Rooster" ready · you are the owner
```

After that the full toolset appears and you can start filing tickets
immediately.

> Self-hosting non-interactively (e.g. seeding a tenant from CI)? The HTTP
> `POST $ROOSTER_URL/onboard` endpoint still exists and can bind a headless
> `agent.oauthClientId`; see [`docs/SELF_HOSTING.md`](../docs/SELF_HOSTING.md).

## 3. Work

In Claude Code, the Rooster tools become available — e.g.:

- `whoami` — confirm identity, org and scopes
- `create_team` / `create_project` — grow the workspace
- `create_ticket` — open work (add `labels`, set `parentId` for subtasks,
  `dueDate` for deadlines)
- `change_status`, `assign_ticket`, `comment`
- `list_tickets` (filter by `status`/`assigneeId`), `my_tickets`,
  `find_by_label`, `search_tickets`, `list_subtasks`, `crow`
- `invite_member` (by email) / `create_invite` (shareable join code) — bring in
  teammates; they `join_tenant` on first connect
- `read_audit` — who did what

Every action is permission-checked and recorded in the audit log, attributed to
the agent's trusted identity (visible in the dashboard at `/app/audit`).
