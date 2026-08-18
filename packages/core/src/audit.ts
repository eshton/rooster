import type { Repositories } from '@rooster/db'
import type { Actor } from './actor.js'
import { withRetry } from './retry.js'

export interface AuditInput {
  action: string
  targetType: string
  targetId: string | null
  before?: unknown
  after?: unknown
}

/**
 * Append an audit record attributed to the trusted `principalId`, carrying the
 * untrusted `clientInfo` snapshot for display. Called from every mutating
 * service method so attribution is uniform and append-only.
 *
 * The append is retried on transient infra failure ({@link withRetry}) because
 * it runs *after* the mutation's own row is written and is not in the same
 * transaction (no portable cross-connection transaction — see CLAUDE.md's
 * in-memory libSQL caveat). A flaky audit insert was what left `create_tickets`
 * batches partially applied (ROO-33); centralising the retry here hardens every
 * audited mutation — status changes, moves, assignments, comments, … — the same
 * way, not just ticket creation. A `CoreError` (a real domain failure) is never
 * retried.
 */
export async function recordAudit(
  repos: Repositories,
  actor: Actor,
  input: AuditInput,
): Promise<void> {
  await withRetry(() =>
    repos.audit.append(actor.orgId, {
      principalId: actor.principalId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      before: input.before ?? null,
      after: input.after ?? null,
      clientInfo: actor.clientInfo ?? null,
    }),
  )
}
