# Estimating tickets in Rooster

Rooster's ticket `estimate` field is sized **mostly by agents**, not humans. That
changes what a good estimation scale looks like.

Classic story points are calibrated by a human team's shared *velocity*, built up
over many sprints ("for us, this feels like a 5"). Agents have no such shared
baseline — ask three agents to size the same ticket with a freeform number and you
get 4, 5, and 8. So Rooster fixes a **discrete scale anchored to objective,
checkable signals**. The goal is reproducibility: similarly-shaped work gets the
same score regardless of who — or what — estimates it.

The scale lives in code as `ESTIMATE_POINTS` / `estimatePointsSchema`
(`packages/schema/src/enums.ts`) and is **enforced**: `create_ticket` /
`update_ticket` reject any value that isn't on the scale.

## The scale: Fibonacci complexity points

`estimate ∈ { 1, 2, 3, 5, 8, 13 }` (or `null` = unsized).

Two rules first, because they're where agents drift:

1. **Score complexity + uncertainty, not wall-clock time.** Estimator speed
   varies (a fast agent and a slow human should still agree on the number);
   complexity is intrinsic to the work. "How hard and how unknown," not "how long."
2. **The scale is ordinal, not linear.** The gaps widen on purpose — the jump
   from 8 to 13 encodes "and the uncertainty is now large," not "1.6× the effort."
   When a ticket sits between two values, **round up**.

| Pts | Label | The work looks like… |
|----:|-------|----------------------|
| **1** | Trivial | A single, obvious change in one file. Mechanical; copies an existing pattern; no design decisions; tests unchanged or trivial. (Fix a typo, tweak a constant, add a value to an existing list.) |
| **2** | Small | A handful of files within one package/layer. Approach is clear, minor new logic, one or two simple tests. No new abstractions. |
| **3** | Moderate | Crosses 2–3 layers but follows a **documented** pattern. A few edge cases; a focused test addition. |
| **5** | Sizable | A new component/service or a cross-cutting change. Several edge cases; non-trivial tests; some unknowns you resolve while building. |
| **8** | Large | A new subsystem, or many modules touched. Meaningful design work up front; real uncertainty; a broad test surface. |
| **13** | Epic / uncertain | Architectural change, **or** enough unknowns that any single number is unreliable. Don't file a 13 — **split it into subtasks** and estimate those. |

## Signals to score against

When you're unsure which bucket, count the objective signals. More signals, or
signals higher in this list, push the estimate up:

- **Files / packages touched** and **layers crossed** (schema → db → core → mcp → dashboard).
- **New tables or a migration?** **New abstractions** (a new service, a new entity)?
- **Back-compat blast radius** — does it change a shared contract many call sites depend on?
- **Test surface** — one assertion, or a new suite across dialects?
- **How known is the approach** — copying a documented pattern (low) vs. designing something novel (high)?

## Worked example: "Add a ticket field" = 3

Rooster's own `estimate` field (ROOST-2) is a textbook **3**. It crossed several
layers — `schema` (entity + DTOs), `db` (both dialect schemas + a migration),
`core` (the create path), `mcp` (tool surface), and the dashboard — but every
step followed the documented "Add a ticket field" recipe in `CLAUDE.md`, the edge
cases were few, and the tests were focused. Crosses layers + documented pattern +
a few edge cases ⇒ 3, not 5 (no real unknowns) and not 2 (more than one layer).

By contrast:
- A one-line copy tweak in a single file ⇒ **1**.
- "Add a `startDate` field" identical to an existing one ⇒ **2–3** (same recipe, even less novel).
- "Per-project configurable workflows" (ROOST-10 — moves global status/transition
  rules into per-project config, touches status validation broadly, needs design) ⇒ **8**.
- "Custom fields" (ROOST-9 — a whole definition/value model to design first) ⇒ **13, split it.**

## Where the rules live (keep in sync)

- `packages/schema/src/enums.ts` — `ESTIMATE_POINTS`, `ESTIMATE_RUBRIC` (the
  compact rubric surfaced to agents), and the enforced `estimatePointsSchema`.
- `/llms.txt` (`apps/server/src/discovery.ts`) — the "Estimating work" section
  agents read when they connect.
- This file — the full rubric + worked examples.

If you change the scale or the rubric, update all three together.
