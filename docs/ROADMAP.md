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
| 2 | Start date | fields | S | ✅ done |
| 3 | Milestones / cycles (sprints) | planning | M | ✅ done |
| 4 | Multiple assignees | collaboration | M | ✅ done |
| 5 | Ticket relations (blocks / relates / duplicates) | linking | M | ✅ done |
| 6 | Attachments (links, then files) | content | M | ✅ links done |
| 7 | Watchers + notifications | collaboration | M | ✅ done |
| 8 | Custom fields | extensibility | L | backlog |
| 9 | Per-project configurable workflows | workflow | L | backlog |
| 10 | Cross-workspace membership | identity | L | ✅ done |
| 11 | CI auto-deploy on merge (ROO-13 follow-up) | infra | M | ✅ done |
| 12 | Agent memory: conversation recall + context files + semantic search | agent-memory | L | ✅ done |

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

## 2. Start date — `fields` · S · ✅ done
**Why:** model work that has a planned start, not just a deadline; enables
date-range/Gantt-style views later.
**Shipped:** nullable `startDate` (ISO-8601) mirrored end-to-end alongside
`dueDate` — both dialect schemas, the ticket entity + create/update DTOs, and
the repo mapping; surfaced over MCP via the DTO `.shape`.

## 3. Milestones / cycles (sprints) — `planning` · M · ✅ done
**Why:** group tickets into a release or time-boxed cycle and track progress.
**Shipped:** `milestones` entity + `MilestoneService`
(`packages/core/src/services/milestones.ts`), nullable `ticket.milestoneId`, MCP
tools `create_milestone` / `list_milestones`, and a `milestoneId` filter on
`list_tickets`.

## 4. Multiple assignees — `collaboration` · M · ✅ done
**Why:** real work is often shared (pair/mob, human + agent).
**Shipped:** ticket↔principal join with an `assignees[]` projection; MCP tools
`add_assignee` / `remove_assignee` / `list_assignees`; `my_tickets` matches any
assignee. `assigneeId` is retained as the derived primary for back-compat.

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

## 7. Watchers + notifications — `collaboration` · M · ✅ done
**Why:** let people/agents follow a ticket and be notified on changes — a
natural extension of `crow`.
**Shipped:** `ticket_watchers` + `WatcherService`
(`packages/core/src/services/watchers.ts`); MCP tools `watch_ticket` /
`unwatch_ticket` / `my_watches` / `list_watchers`; changes emit through the
existing `CrowNotifier` seam (`packages/core/src/notify.ts`), delivered by the
webhook notifier wired from `ROOSTER_CROW_WEBHOOK_URL`.

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

## 11. CI auto-deploy on merge — `infra` · M · ✅ done
**Why:** follow-up to ROO-13. CI *verified* every path but deploying was manual,
which is how the live Worker drifted behind `main` (stale base URL, then the
markdown renderer not shipped) — verification without deployment left a
"merged but not live" gap.
**Shipped:** two `.github/workflows/ci.yml` jobs, both `if` push-to-`main` +
`environment: production` and gated on the verify matrix (`needs: [verify,
migrations-in-sync, worker-bundle]` / `[verify, sites]`):
- **`deploy-server`** — applies `db:migrate` then `auth:migrate` to Turso first
  (schema lands before the new code serves), `wrangler deploy`s the Worker, then
  post-deploy smoke-checks `/healthz`, `/.well-known/rooster` (asserting
  `BASE_URL`), `/llms.txt` and both OAuth discovery aliases.
- **`deploy-sites`** — `wrangler pages deploy`s the marketing + docs bundle.

Secrets/vars live in the repo's `production` GitHub Environment
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `DATABASE_URL`,
`DATABASE_AUTH_TOKEN`, `ROOSTER_AUTH_SECRET`, `CLOUDFLARE_PAGES_PROJECT`); if
unset the deploy jobs fail at their step while the verify matrix stays green.

## 12. Agent memory — `agent-memory` · L · ✅ done
**Why:** agents are first-class principals, so they need durable memory across
sessions and projects — not just tickets.
**Shipped:**
- **Conversation recall (ROO-31)** — `conversation.ts` service; MCP
  `append_messages` / `list_messages` / `recall_conversations` (cross-project).
- **Context files (ROO-32)** — `contextfile.ts` service; MCP `save_context_file`
  / `list_context_files`, with a unified `recall_context` spanning tickets,
  conversations, and files.
- **Semantic search** — libSQL native vectors (`F32_BLOB` + `vector_top_k`) via
  the non-Drizzle `embeddings` store (`packages/db/src/vector.ts`); MCP
  `find_similar_tickets` / `backfill_embeddings`; configurable
  `ROOSTER_EMBEDDING_DIMS`, Cloudflare Workers AI embedder.
