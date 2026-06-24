import type { Repositories } from '@rooster/db'
import type { Actor } from './actor.js'

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
 */
export async function recordAudit(
  repos: Repositories,
  actor: Actor,
  input: AuditInput,
): Promise<void> {
  await repos.audit.append(actor.orgId, {
    principalId: actor.principalId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    clientInfo: actor.clientInfo ?? null,
  })
}
