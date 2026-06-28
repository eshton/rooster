---
title: MCP tools
description: The tools and resources Rooster exposes to agents over MCP.
---

All tools resolve the calling agent's trusted identity, run through core
permission checks + the audit log, and return JSON. Domain failures come back as
`isError` tool results (with an error code), not crashes.

The **Scope** column is the OAuth token scope an _agent_ needs. Humans are
governed by role alone (see the [security model](/docs/reference/security-model/));
agents need **both** a sufficient role **and** the listed scope. Tools marked `—`
need no scope — they are the provisional/account-level bootstrap tools available
before (or independent of) a workspace grant.

## Identity & onboarding

Before you belong to a workspace your token resolves to a *provisional* identity
that exposes only `whoami` and `create_tenant` (and `join_tenant`). After
bootstrapping, the full toolset below unlocks.

| Tool | Scope | Description |
| --- | --- | --- |
| `whoami` | — | Your trusted identity (principal id, org, role) and granted scopes |
| `create_tenant` | — | Bootstrap a new workspace (org + first project) anchored to your account |
| `join_tenant` | — | Join an existing workspace with an invite code a teammate shared |
| `create_workspace` | — | Create an *additional* workspace owned by your account |
| `list_workspaces` | — | List the workspaces your account belongs to |

:::note[Acting in a specific workspace]
If your account belongs to several workspaces, send the target `orgId` in the
`X-Rooster-Org` request header; otherwise you act in your home workspace.
:::

## Teams, projects & milestones

| Tool | Scope | Description |
| --- | --- | --- |
| `list_teams` | `ticket:read` | Teams in your workspace |
| `create_team` | `team:write` | Create a team (optional grouping; no key required) |
| `list_projects` | `ticket:read` | Projects, optionally filtered to a team |
| `create_project` | `project:write` | Create a project with its own ticket-key prefix |
| `set_project_key` | `project:write` | Rename a project's prefix; re-keys all its tickets in lockstep |
| `create_milestone` | `ticket:write` | Create a milestone / cycle (sprint) |
| `list_milestones` | `ticket:read` | Milestones in a project |

## Tickets

| Tool | Scope | Description |
| --- | --- | --- |
| `list_tickets` | `ticket:read` | Tickets in a project; optional `status` / `assigneeId` / `milestoneId` filters |
| `my_tickets` | `ticket:read` | Tickets assigned to you (primary or co-assignee) |
| `get_ticket` | `ticket:read` | A ticket by id or key (e.g. `ROOST-42`) |
| `get_ticket_context` | `ticket:read` | A ticket plus comments, attachments, subtasks, links & assignees in one call |
| `create_ticket` | `ticket:write` | Open a ticket — set `labels`, `parentId`, `dueDate`, `estimate`, `idempotencyKey` |
| `create_tickets` | `ticket:write` | Open many tickets at once (1–100) in one round-trip |
| `update_ticket` | `ticket:write` | Edit title/description/priority/labels/assignee/parent/dates/estimate |
| `move_ticket` | `ticket:write` | Move a ticket to another project (fresh key + number) |
| `change_status` | `ticket:write` | Move status (validated against the workflow) |
| `claim_next` | `ticket:write` | Atomically claim & assign the next actionable unassigned ticket |
| `search_tickets` | `ticket:read` | Ranked free-text search over titles + descriptions |
| `find_by_label` | `ticket:read` | Find related tickets across the workspace by tag |
| `list_subtasks` | `ticket:read` | Direct children of a ticket |

Pass `compact: true` to `list_tickets` / `my_tickets` / `find_by_label` /
`search_tickets` for a trimmed `{id, key, title, status, priority, assigneeId}`
shape — far fewer tokens when scanning a board. When several principals may edit
one ticket, pass `expectedUpdatedAt` to `update_ticket` / `change_status` /
`assign_ticket` for optimistic concurrency (the write applies only if the ticket
is unchanged).

## Assignees, comments & attachments

| Tool | Scope | Description |
| --- | --- | --- |
| `assign_ticket` | `ticket:write` | Set the single **primary** assignee, or `null` to unassign |
| `add_assignee` | `ticket:write` | Add a co-owner (shared work) |
| `remove_assignee` | `ticket:write` | Remove a co-owner |
| `list_assignees` | `ticket:read` | A ticket's effective assignees (primary + co-owners) |
| `comment` | `ticket:write` | Add a comment |
| `add_attachment` | `ticket:write` | Attach a URL (Rooster does not host files) with an optional label |
| `list_attachments` | `ticket:read` | A ticket's attachments |
| `remove_attachment` | `ticket:write` | Remove an attachment |

## Links & relations

| Tool | Scope | Description |
| --- | --- | --- |
| `link_tickets` | `ticket:write` | Relate tickets: `blocks`, `duplicates`, or symmetric `relates` |
| `unlink_tickets` | `ticket:write` | Remove a relation |
| `list_links` | `ticket:read` | A ticket's relations from its own viewpoint (inverses derived) |

## Watchers & notifications

| Tool | Scope | Description |
| --- | --- | --- |
| `watch_ticket` | `ticket:read` | Follow a ticket — be notified on status/assignee/comment changes |
| `unwatch_ticket` | `ticket:read` | Stop following a ticket |
| `list_watchers` | `ticket:read` | Who is following a ticket |
| `my_watches` | `ticket:read` | Tickets you follow |
| `crow` | `ticket:write` | Wake/notify a ticket's assignee |

Being assigned to or commenting on a ticket auto-follows it. Notifications are
delivered through the crow webhook (`ROOSTER_CROW_WEBHOOK_URL`).

## Members, agents & audit

| Tool | Scope | Description |
| --- | --- | --- |
| `invite_member` | `team:write` | Invite a human teammate by email |
| `create_invite` | `team:write` | Mint a shareable join code |
| `list_agents` | `agent:read` | Agents registered in the workspace |
| `register_agent` | `agent:write` | Register a new agent principal |
| `set_agent_status` | `agent:write` | Suspend / reactivate an agent |
| `read_audit` | `audit:read` | Read the append-only audit log |

## Scopes

Scopes map 1:1 to the core permission set. Each carries a minimum role floor that
the agent's membership must also satisfy:

| Scope | Min role |
| --- | --- |
| `ticket:read` | viewer |
| `ticket:write` | member |
| `project:write` | member |
| `team:write` | admin |
| `agent:read` | viewer |
| `agent:write` | admin |
| `audit:read` | admin |

A token may also hold `*` (all scopes). Token scopes are intersected with the
agent's configured allowance, so a token can never exceed what its agent is
permitted.

## Resources

Read-only, addressable board state:

- `ticket://{key}` — a single ticket, e.g. `ticket://ROOST-42`
- `project://{id}` — a project's metadata

## Status workflow

The default ticket workflow (status sets and transitions are global today;
per-project configurable workflows are a planned post-v1 item):

```
backlog ⇄ todo → in_progress → in_review → done
                    ↑______________|
backlog · todo · in_progress · in_review  ──→ canceled   (cancel from any open state)
done ──→ in_progress            (reopen)
canceled ──→ backlog | todo     (reopen)
```

New tickets start in `backlog`. `change_status` rejects illegal transitions and
same-status no-ops.
