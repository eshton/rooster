import type { Repositories } from '@rooster/db'
import { z } from 'zod'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import type { Id, Membership } from './deps.js'

const upsertMemberInput = z.object({
  principalId: z.uuid(),
  teamId: z.uuid().nullable().default(null),
  role: z.enum(['viewer', 'member', 'admin', 'owner']),
})
export type UpsertMemberInput = z.infer<typeof upsertMemberInput>

export interface MemberService {
  /** Grant or change a principal's role (org-level or team-scoped). Admin-only. */
  upsert(actor: Actor, input: UpsertMemberInput): Promise<Membership>
  list(actor: Actor, principalId: Id): Promise<Membership[]>
}

export function createMemberService(repos: Repositories): MemberService {
  return {
    async upsert(actor, rawInput) {
      authorize(actor, 'team:write')
      const input = parse(upsertMemberInput, rawInput)

      const principal = await repos.principals.getById(actor.orgId, input.principalId)
      if (!principal) throw new NotFoundError(`Principal ${input.principalId} not found`)

      const membership = await repos.memberships.upsert(actor.orgId, {
        principalId: input.principalId,
        teamId: input.teamId,
        role: input.role,
      })
      await recordAudit(repos, actor, {
        action: 'membership.upsert',
        targetType: 'principal',
        targetId: input.principalId,
        after: { teamId: input.teamId, role: input.role },
      })
      return membership
    },

    async list(actor, principalId) {
      authorize(actor, 'agent:read')
      return repos.memberships.list(actor.orgId, principalId)
    },
  }
}
