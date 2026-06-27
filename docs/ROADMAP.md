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
| 1 | Estimates / story points | fields | S | ✅ done |
| 2 | Start date | fields | S | backlog |
| 3 | Milestones / cycles (sprints) | planning | M | backlog |
| 4 | Multiple assignees | collaboration | M | backlog |
| 5 | Ticket relations (blocks / relates / duplicates) | linking | M | ✅ done |
| 6 | Attachments (links, then files) | content | M | ✅ links done |
| 7 | Watchers + notifications | collaboration | M | backlog |
| 8 | Custom fields | extensibility | L | backlog |
| 9 | Per-project configurable workflows | workflow | L | backlog |
| 10 | Cross-workspace membership | identity | L | ✅ done |
| 11 | CI auto-deploy on merge (ROOST-13 follow-up) | infra | M | backlog |

---

## 1. Estimates / story points — `fields` · S · ✅ done
**Why:** size work for planning and velocity.
**Shipped:** nullable `estimate` added to `ticketSchema` + both dialect schemas
+ migrations 0006, the `create/updateTicketInput` DTOs, and threaded through
`tickets.create` (update flows through the generic patch path). Surfaced over
MCP automatically via the DTO `.shape` on `create_ticket`/`update_ticket`, and
in the SSR dashboard (create form, edit form, board cards, ticket detail "N pts"
chip). Covered by `mcp.test.ts` (create + re-size + reject off-scale + clear)
and `dashboard.test.ts` (form round-trip).
**Estimation is agent-first:** rather than freeform story points (which diverge
without a shared velocity baseline), `estimate` is an **enforced** Fibonacci
*complexity-point* scale `{1,2,3,5,8,13}` anchored to objective signals so any
agent sizes similar work the same way. Scale + rubric: `ESTIMATE_POINTS` /
`estimatePointsSchema` (`packages/schema/src/enums.ts`), the `/llms.txt`
"Estimating work" section, and [`docs/ESTIMATION.md`](ESTIMATION.md).

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

## 5. Ticket relations — `linking` · M · ✅ done
**Why:** express *blocks / blocked-by / relates-to / duplicates* beyond the
existing parent/child hierarchy.
**Shipped:** `ticket_links` table (org-scoped, unique on org+from+to+type) +
repo + service folded into `tickets.ts`. A link is one directed edge; the
inverse is derived on read (blocks⇄blocked_by, duplicates⇄duplicated_by, relates
symmetric). Guards reject self-links, duplicates (incl. the relates mirror), and
cycles in the blocks graph. MCP tools `link_tickets` / `unlink_tickets` /
`list_links` (the last resolves relations from the queried ticket's viewpoint).

## 6. Attachments — `content` · M · ✅ links done
**Why:** attach context (logs, designs, links) to a ticket.
**Shipped (links-only):** `attachments` table (ticketId, addedById, url, label) +
repo + `AttachmentService` + `add_attachment` / `list_attachments` /
`remove_attachment` tools, surfaced on the dashboard ticket detail. Rooster does
not host files — an attachment always references a URL.

### Direct file upload by agents — assessment (not built)
**Can agents upload a file directly?** Not cleanly today, and deliberately so.
- **Over MCP, tool args are JSON.** The only in-band way to ship bytes is
  base64 in a tool argument. That bloats the request, fights MCP/proxy size
  limits, and would land the blob in the portable DB (SQLite/Turso/PG) as
  TEXT/BLOB — exactly the row-size and replication problems the JSON-as-TEXT
  convention avoids. Viable only for tiny files; not recommended as the primary
  path.
- **The clean pattern is a two-step presigned upload.** A new tool
  (`request_upload`) returns a short-lived presigned `PUT` URL from object
  storage (S3 / Cloudflare R2 / Vercel Blob); the agent uploads bytes directly
  to storage, then calls `add_attachment` with the resulting URL. The blob never
  transits Rooster, and the existing links-only model already records the final
  URL — **so no schema change is needed**, only storage config + the issuing
  tool.
- **But it's platform-specific** (each deploy target has a different blob store
  + credentials), which is why it stays a follow-up: it breaks the "one codebase,
  any platform" property unless gated behind a storage adapter interface
  (`putObject`/`presign`) with a no-op default that keeps links-only working
  everywhere.
**Recommended follow-up:** define a `BlobStore` seam (like the `CrowNotifier`/
`EmailSender` seams), implement R2 + S3 adapters, add `request_upload`, and keep
`add_attachment(url)` as the registration step. Until then: links only.

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

## 10. Cross-workspace membership — `identity` · L · ✅ done
**Why:** the original model was **one user → one principal → one org**, so a person
who already owned a workspace could not also join another (the limitation hit by
`invite_member` / `join_tenant`). Real teams need one account across multiple
workspaces.
**Shipped:** identity is now a principal **per (user, org)**, linked back to the
global account via `principals.userId` (migration 0005). A user joining a new
workspace via an invite gets a fresh principal linked to the same account
(`invites.redeem`); `humanIdentityFromSessionEmail` takes an active-org argument
and the dashboard adds a workspace switcher (`/app/switch`, `rooster_org`
cookie). Legacy rows are lazily back-linked on read. MCP stays anchored to the
account's home org. Covered by `core.test.ts` (cross-workspace redeem,
idempotent re-join) and `auth.test.ts` (multi-org resolution).
**Not yet:** an MCP-side workspace selector (a token resolves to the home org
only) and creating a *second* tenant from an already-onboarded account.

## 11. CI auto-deploy on merge — `infra` · M
**Why:** follow-up to ROOST-13. CI now *verifies* every path (lint/build/test,
Postgres migrations, migration-drift, pg-free Worker bundle), but deploying is
still manual — which is exactly how the live Worker drifted behind `main`
(stale base URL, then the markdown renderer not shipped). Verification without
deployment leaves the "merged but not live" gap open.
**Scope:** a GitHub Actions deploy workflow that, on push to `main` (after the
verify jobs pass), (1) deploys the Worker via `wrangler deploy` using a
`CLOUDFLARE_API_TOKEN` secret, (2) runs `db:migrate` against the production
Turso DB so schema changes land with the code, (3) deploys the marketing +
docs Pages bundle (`build:web` → `dist-web/`), and (4) post-deploy smoke-checks
`/healthz`, `/.well-known/rooster` (asserting the base URL) and the OAuth
discovery aliases. Gate prod steps on `main` + environment protection; keep
secrets in GitHub Environments.
**Deps:** builds on the CI verification jobs (ROOST-13). Needs the Cloudflare
API token + Turso credentials as repo/environment secrets.
**Suggested:** label `roadmap,infra,ci,deploy`, priority `high`.
