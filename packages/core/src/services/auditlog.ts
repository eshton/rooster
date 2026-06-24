import type { ListOptions, Repositories } from '@rooster/db'
import type { AuditLog } from '@rooster/schema'
import type { Actor } from '../actor.js'
import { authorize } from '../permissions.js'

export interface AuditLogService {
  /** Read the append-only audit log for the actor's org. Admin-only. */
  list(actor: Actor, opts?: ListOptions): Promise<AuditLog[]>
}

export function createAuditLogService(repos: Repositories): AuditLogService {
  return {
    async list(actor, opts) {
      authorize(actor, 'audit:read')
      return repos.audit.list(actor.orgId, opts)
    },
  }
}
