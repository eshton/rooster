# Proposed tickets — agent performance & efficiency

Drafted from the "make Rooster faster / more efficient / more useful for agents"
brainstorm. File these in the **Rooster** project (prefix `ROO-`,
projectId `e0ec50cf-ba35-4b90-9901-43b715c9ba92`).

Ideas 4, 5, 6 from that brainstorm are **already shipped** (commit `1d98e66`):
`get_ticket_context`, compact list mode, and batch `create_tickets`. The five
below are the remaining proposals.

When filing, use the `estimate` (Fibonacci complexity points) and `labels` shown.
Estimates follow `docs/ESTIMATION.md`.

---

## 1. Cache resolved Actor on the MCP hot path (+ single-query resolveActor)

- **labels:** `roadmap`, `performance`, `mcp`
- **priority:** high
- **estimate:** 5

Every stateless `/mcp` tool call re-runs the full identity chain before any real
work: better-auth token validation → agent lookup by OAuth client id →
`principals.getById` → `memberships.list` → role reduction. That's 4+ sequential
DB round-trips per call, paid on every tool invocation.

**Two changes:**

1. **Cache the resolved Actor by token hash with a short TTL (~30–60s).** Key on
   a hash of the bearer token (never the raw token). On hit, skip the whole
   resolve chain. Short TTL means role/scope/membership changes self-heal without
   explicit invalidation — acceptable staleness for a 30–60s window. Must be
   portable: an in-memory LRU for the Node entry, and a KV-backed impl for the
   Cloudflare Workers entry (mirror the existing driver/platform split). Keyed by
   token, so it naturally scopes per-principal.
2. **Collapse `resolveActor` to a single query.** Today `actor.ts` does
   `principals.getById` then `memberships.list` as two awaits. Fold into one
   round-trip (join principal + memberships) so cache misses are cheaper too.

**Scope:** portable cache seam (Node + edge impls wired at the server entries),
`resolveActor` query collapse in `packages/db` + `packages/core/src/actor.ts`,
tests for cache hit/miss/expiry and the single-query path.

**Out of scope:** caching tool *results* (separate concern).

_Source: agent perf brainstorm (idea 1+3)._

---

## 2. Add indexes backing the hot list/search query paths

- **labels:** `roadmap`, `performance`, `db`
- **priority:** high
- **estimate:** 3

The schemas today carry only the unique constraints; the hot read paths have no
backing index and currently rely on a full scan capped at
`SEARCH_CANDIDATE_CAP = 1000`. Fine at demo size, a cliff edge at real size.

**Add (both dialects, structurally identical):**

- `tickets(orgId, projectId, status)` — backs `list_tickets` board reads + status filter.
- `tickets(orgId, assigneeId)` and `ticket_assignees(orgId, principalId)` — back `my_tickets` (primary OR co-assignee union, post ROO-5).
- `tickets(orgId, milestoneId)` — backs milestone-filtered board reads.
- `audit_log(orgId, createdAt)` — backs the audit viewer's reverse-chron list.
- `comments(orgId, ticketId)` — backs `list_comments` / `get_ticket_context`.

**Scope:** edit `schema/sqlite.ts` + `schema/pg.ts` identically,
`db:generate:sqlite` + `db:generate:pg`, format the migration meta. No app logic
change. Low risk, documented pattern.

_Source: agent perf brainstorm (idea 2). Confirmed: only unique indexes exist on
these tables today._

---

## 3. claim_next — atomic "what should I work on?" work dispatch

- **labels:** `roadmap`, `agents-first`, `mcp`
- **priority:** high
- **estimate:** 8

The agents-first killer feature: a tool that turns Rooster from a record-keeper
into a work dispatcher. An agent asks for the next thing to do and gets it
assigned atomically.

**Behaviour:** `claim_next(projectId)` selects the highest-priority, oldest,
**unblocked** ticket in the project that is in an actionable status
(e.g. todo/backlog) and unassigned, assigns it to the calling principal, and
returns it — in one atomic step so two agents racing don't claim the same ticket.

**Design points to resolve:**

- "Unblocked" = no open `blocks` link pointing at it (respect the ticket-links graph).
- Ordering: priority desc, then createdAt asc (FIFO within a priority).
- Atomicity without transactions (libSQL in-memory caveat) — use a single
  conditional `UPDATE ... WHERE id = (SELECT ... LIMIT 1) AND assigneeId IS NULL
  RETURNING`, mirroring the `nextNumber` atomic pattern.
- Principal-agnostic (agent or human can claim).

**Scope:** core service method (authorize + audit), MCP tool, /llms.txt, core +
MCP e2e tests (including a no-double-claim concurrency assertion). Real design
work + broad test surface ⇒ 8.

_Source: agent perf brainstorm (idea 7)._

---

## 4. Idempotency keys on create_ticket (retry-safe creation)

- **labels:** `roadmap`, `agents-first`, `reliability`
- **priority:** medium
- **estimate:** 3

Agents retry on timeout/network failure; a client-supplied idempotency key lets
`create_ticket` dedupe so a flaky connection doesn't double-file the same ticket.

**Behaviour:** optional `idempotencyKey` on `create_ticket`. First call with a
given (org, key) creates and records the key→ticketId mapping; a repeat returns
the original ticket instead of creating a second. Keys are scoped per-org.
Retention is simpler than expiry and safe.

**Scope:** new column or small table for the key→ticket mapping (both dialects +
migration), DTO field, core create path checks/records the key atomically
(single-statement upsert, no transaction), MCP tool surface, tests for the dedup
path. Pairs naturally with the batch `create_tickets` (idea 6, already shipped).

_Source: agent perf brainstorm (idea 8)._

---

## 5. Optimistic concurrency on ticket updates (expectedUpdatedAt)

- **labels:** `roadmap`, `agents-first`, `reliability`
- **priority:** medium
- **estimate:** 3

Two principals editing one ticket is now common (ROO-5 lets multiple agents
co-own a ticket). Today the update paths are last-write-wins and silently clobber.

**Behaviour:** optional `expectedUpdatedAt` on `update_ticket` / `change_status`
/ `assign_ticket`. When supplied, the write only applies if the row's current
`updatedAt` matches; otherwise it fails with a Conflict error so the caller can
re-read and retry. Omitting the field preserves today's last-write-wins behaviour
(back-compat).

**Scope:** DTO field, core update path enforces the check (single conditional
`UPDATE ... WHERE updatedAt = expected RETURNING`; no row updated ⇒
ConflictError), MCP tool surface, /llms.txt note, core + MCP e2e tests for the
conflict + success paths.

_Source: agent perf brainstorm (idea 9)._
