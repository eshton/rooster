# Rooster public roadmap

What we've shipped and what's planned for **Rooster** — the open-source project
manager for software agents. This roadmap is generated from Rooster's own live
backlog (project `ROO`, workspace *Rooster Dev*), which Rooster tracks in
itself via its MCP server — so it reflects the real state of work, not a wishlist.

_Last synced: 2026-06-28._

> Looking for the design rationale behind these items? See
> [`ROADMAP.md`](ROADMAP.md) for the original capability notes that seeded this
> backlog. This file is the status-oriented, ticket-derived view.

## At a glance

| Status | Count |
|--------|------:|
| ✅ Shipped | 19 |
| 🗓️ Planned | 6 |

19 features shipped across performance, agent-first workflows, identity, and
CI/CD; 6 planned, spanning search, extensibility, and richer attachments.

---

## ✅ Shipped

### Agents-first workflows & reliability
- **`claim_next` — atomic work dispatch** (`ROO-25`) · 8 pts · high — an agent
  asks "what should I work on?" and is atomically assigned the highest-priority,
  oldest, *unblocked* actionable ticket. Turns Rooster from a record-keeper into
  a work dispatcher; no two racing agents can claim the same ticket.
- **Idempotency keys on `create_ticket`** (`ROO-26`) · 3 pts · medium — a
  client-supplied key dedupes creation so a flaky connection can't double-file
  the same ticket.
- **Optimistic concurrency on updates** (`ROO-27`) · 3 pts · medium — optional
  `expectedUpdatedAt` on update/status/assign so co-owned tickets don't silently
  clobber each other; conflicts surface so the caller can re-read and retry.

### Performance
- **Cache resolved Actor on the MCP hot path** (`ROO-23`) · 5 pts · high —
  short-TTL, token-hashed cache plus a single-query `resolveActor`, cutting the
  4+ sequential identity round-trips paid on every stateless tool call.
- **Indexes backing the hot list/search paths** (`ROO-24`) · 3 pts · high —
  composite indexes for board reads, `my_tickets`, milestone filters, the audit
  viewer, and comments — removing the full-scan cliff at real size.

### Planning & ticket fields
- **Estimates / story points** (`ROO-2`) — enforced Fibonacci complexity-point
  scale, surfaced over MCP and in the dashboard.
- **Start date** (`ROO-3`) — nullable planned-start date, enabling date-range
  views.
- **Milestones / cycles (sprints)** (`ROO-4`) — group tickets into a release or
  time-boxed cycle, with a `milestoneId` filter on `list_tickets`.

### Collaboration
- **Multiple assignees** (`ROO-5`) — shared ownership (pair/mob, human + agent)
  via a `ticket_assignees` join, with `assigneeId` kept as the primary.
- **Watchers + notifications** (`ROO-8`) — follow a ticket and get notified on
  changes through the `crow` webhook seam.

### Linking & content
- **Ticket relations** (`ROO-6`) — blocks / blocked-by / relates / duplicates
  beyond the parent/child hierarchy, with cycle and duplicate guards.
- **Attachments (links)** (`ROO-7`) — attach context by URL; the model is
  forward-compatible with direct file upload (see Planned).

### Identity & onboarding
- **Cross-workspace membership** (`ROO-11`) — one account across multiple
  workspaces (a principal per user+org).
- **MCP-side workspace selector** (`ROO-14`) — choose/switch the active
  workspace over MCP, not just on the dashboard.
- **Create additional workspaces from an onboarded account** (`ROO-15`) — spin
  up a second workspace without being a fresh, orgless caller.

### Core correctness & ergonomics
- **Self-healing ticket numbering** (`ROO-19`) · high — `nextNumber` can never
  re-mint an existing key, even if the counter drifts behind reality.
- **Re-key / move tickets without raw SQL** (`ROO-20`) — first-class
  `set_project_key` and `move_ticket` replace error-prone hand-edited SQL.

### Infrastructure & CI/CD
- **CI + live deploy validation** (`ROO-13`) · high — GitHub Actions running
  lint/build/test, a real Postgres job, migration-drift checks, and a pg-free
  Worker bundle check.
- **CI auto-deploy to Cloudflare on merge** (`ROO-22`) · high — gated deploy
  jobs (server Worker + marketing/docs Pages, Turso migrations, post-deploy
  smoke) closing the "merged but not live" gap.

---

## 🗓️ Planned

### Search
- **Full-text search (portable FTS)** (`ROO-12`) · medium — replace `LIKE` with
  ranked full-text search across all targets: Postgres `tsvector`/GIN and
  SQLite/Turso FTS5. No new dependencies, same tool signature.
- **Semantic (vector) search** (`ROO-18`) · low — an optional embedding layer on
  top of FTS (Postgres + pgvector) so agents find conceptually-related work.
  Follows FTS; Postgres-only.

### Extensibility & workflow
- **Custom fields** (`ROO-9`) · low — per-project field definitions plus
  per-ticket JSON values, with generic get/set tools.
- **Per-project configurable workflows** (`ROO-10`) · medium — move the global
  status set and transition graph into per-project config, keeping today's list
  as the default.

### Content
- **Direct file upload for attachments** (`ROO-21`) · low — a `BlobStore` seam
  plus `request_upload` two-step presigned upload (R2 / S3), keeping the
  links-only model working everywhere via a no-op default. Follows `ROO-7`.

### Auth
- **Auth follow-ups** (`ROO-16`) · low — opt-in email verification (gated on a
  configured sender) and a few more social login providers.

---

_This roadmap is derived from the live `ROO` backlog and excludes internal
setup/test tickets. Priorities and estimates reflect the current backlog and may
change as work is picked up._
