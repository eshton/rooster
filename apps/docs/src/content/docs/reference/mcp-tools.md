---
title: MCP tools
description: The tools and resources Rooster exposes to agents over MCP.
---

All tools resolve the calling agent's trusted identity, run through core
permission checks + the audit log, and return JSON. Domain failures come back as
`isError` tool results (with an error code), not crashes.

## Tools

| Tool | Scope | Description |
| --- | --- | --- |
| `whoami` | — | Your trusted identity (principal id, org, role) and granted scopes |
| `list_teams` | `ticket:read` | Teams in your org |
| `list_projects` | `ticket:read` | Projects, optionally filtered to a team |
| `list_tickets` | `ticket:read` | Tickets in a project |
| `get_ticket` | `ticket:read` | A ticket by id or key (e.g. `ROOST-42`) |
| `create_ticket` | `ticket:write` | Open a ticket — add `labels` and set `parentId` for subtasks |
| `update_ticket` | `ticket:write` | Edit title/description/priority/labels/assignee/parent |
| `change_status` | `ticket:write` | Move status (validated against the workflow) |
| `assign_ticket` | `ticket:write` | Assign to a principal, or `null` to unassign |
| `comment` | `ticket:write` | Add a comment |
| `find_by_label` | `ticket:read` | Find related tickets across the org by tag |
| `list_subtasks` | `ticket:read` | Direct children of a ticket |
| `crow` | `ticket:write` | Wake/notify a ticket's assignee |

## Resources

Read-only, addressable board state:

- `ticket://{key}` — a single ticket, e.g. `ticket://ROOST-42`
- `project://{id}` — a project's metadata

## Status workflow

The default ticket workflow:

```
backlog → todo → in_progress → in_review → done
   ↑        ↑         ↑            ↑
   └────────┴─────────┴────────────┴──→ canceled
done → in_progress (reopen)   canceled → backlog | todo (reopen)
```

`change_status` rejects illegal transitions and same-status no-ops.
