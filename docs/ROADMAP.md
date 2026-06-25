# Rooster roadmap — ticket capabilities

Candidate ticket features not yet built. Captured here as Rooster's own backlog;
later we can feed these into Rooster itself as tickets (dogfooding).

A Rooster ticket **today** has: `title`, `description`, `status` (6-state
workflow with transition rules), `priority` (none/low/medium/high/urgent),
`labels` (tags), `assigneeId` (single), `parentId` (subtasks), `dueDate`, the
human `key`, timestamps — plus threaded **comments** as a separate entity.

Effort is a rough t-shirt size. "Scope" names the files a change would touch,
reusing the documented patterns in [`CLAUDE.md`](../CLAUDE.md) ("Add a ticket
field", "Add an MCP tool").

## Backlog at a glance

| # | Feature | Theme | Effort | Status |
|---|---------|-------|:------:|--------|
| 1 | Estimates / story points | fields | S | backlog |
| 2 | Start date | fields | S | backlog |
| 3 | Milestones / cycles (sprints) | planning | M | backlog |
| 4 | Multiple assignees | collaboration | M | backlog |
| 5 | Ticket relations (blocks / relates / duplicates) | linking | M | backlog |
| 6 | Attachments (links, then files) | content | M | backlog |
| 7 | Watchers + notifications | collaboration | M | backlog |
| 8 | Custom fields | extensibility | L | backlog |
| 9 | Per-project configurable workflows | workflow | L | backlog |
| 10 | Cross-workspace membership | identity | L | backlog |

---

## 1. Estimates / story points — `fields` · S
**Why:** size work for planning and velocity.
**Scope:** add nullable numeric `estimate` to `ticketSchema` (entities), both
dialect schemas + migrations, `create/updateTicketInput` DTOs, thread through
`tickets.create/update`. Surface in `create_ticket`/`update_ticket`.
**Suggested:** label `roadmap,fields`, priority `low`.

## 2. Start date — `fields` · S
**Why:** model work that has a planned start, not just a deadline; enables
date-range/Gantt-style views later.
**Scope:** mirror the existing `dueDate` field end-to-end (`startDate`, nullable
ISO-8601). Same pattern as the Tier 2 `dueDate` change.
**Suggested:** label `roadmap,fields`, priority `low`.

## 3. Milestones / cycles (sprints) — `planning` · M
**Why:** group tickets into a release or time-boxed cycle and track progress.
**Scope:** new `milestones` entity (name, dates, projectId) — schema + dialect
tables + migration + repo + a `MilestoneService`; add nullable
`ticket.milestoneId`; MCP tools `create_milestone` / `list_milestones` and a
`milestoneId` filter on `list_tickets`.
**Deps:** pairs well with #2 (start date).
**Suggested:** label `roadmap,planning`, priority `medium`.

## 4. Multiple assignees — `collaboration` · M
**Why:** real work is often shared (pair/mob, human + agent).
**Scope:** introduce a ticket↔principal join (`ticket_assignees`) or an
`assignees[]` projection; migrate the single `assigneeId` path; update
`assign_ticket` (add/remove) and `my_tickets` to match any assignee. Keep
`assigneeId` as a derived "primary" for back-compat, or deprecate.
**Suggested:** label `roadmap,collaboration`, priority `medium`.

## 5. Ticket relations — `linking` · M
**Why:** express *blocks / blocked-by / relates-to / duplicates* beyond the
existing parent/child hierarchy.
**Scope:** new `ticket_links` table (fromTicketId, toTicketId, type) + repo +
service with cycle/duplicate guards (reuse the acyclic logic in
`tickets.ts`); MCP tools `link_tickets` / `list_links`.
**Suggested:** label `roadmap,linking`, priority `medium`.

## 6. Attachments — `content` · M
**Why:** attach context (logs, designs, links) to a ticket.
**Scope:** start **links-only** — `attachments` table (ticketId, url, label) +
repo + service + `add_attachment`/`list_attachments` tools. File upload (blob
storage) is a later, platform-specific follow-up; note it explicitly so we don't
imply uploads work.
**Suggested:** label `roadmap,content`, priority `low`.

## 7. Watchers + notifications — `collaboration` · M
**Why:** let people/agents follow a ticket and be notified on changes — a
natural extension of `crow`.
**Scope:** `ticket_watchers` (ticketId, principalId) + subscribe/unsubscribe
tools; emit through the existing `CrowNotifier` seam
(`packages/core/src/notify.ts`) on status/assignee/comment changes, delivered by
the webhook notifier already wired from `ROOSTER_CROW_WEBHOOK_URL`.
**Deps:** builds directly on the Tier 3 crow-notifier work.
**Suggested:** label `roadmap,collaboration`, priority `medium`.

## 8. Custom fields — `extensibility` · L
**Why:** teams want fields Rooster doesn't model (severity, environment, etc.).
**Scope:** per-project field definitions (`field_defs`: key, type, options) +
per-ticket values stored as JSON-text (consistent with the existing
JSON-as-TEXT convention); validation in the service; generic get/set tools.
Significant surface — design the definition/value model first.
**Suggested:** label `roadmap,extensibility`, priority `low`.

## 9. Per-project configurable workflows — `workflow` · L
**Why:** today `TICKET_STATUSES` and the transition graph
(`packages/core/src/transitions.ts`) are **global**; teams want their own
columns/transitions. Flagged as a post-v1 item in the enum comments.
**Scope:** move status sets + allowed transitions into per-project config
(table + repo), thread the active workflow into `changeStatus` validation, and
keep the current list as the default. Touches status validation broadly.
**Suggested:** label `roadmap,workflow`, priority `medium`.

## 10. Cross-workspace membership — `identity` · L
**Why:** current model is **one user → one principal → one org**, so a person who
already owns a workspace cannot also join another (the limitation hit by
`invite_member` / `join_tenant`). Real teams need one account across multiple
workspaces.
**Scope:** decouple identity from a single principal — e.g. a principal *per
(user, org)* or memberships keyed by account — and rework
`resolveMcpIdentity` / the invite + join paths accordingly. Architectural;
design before building.
**Deps:** affects auth identity bridge and the membership model.
**Suggested:** label `roadmap,identity`, priority `medium`.
