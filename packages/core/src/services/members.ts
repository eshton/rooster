import type { Repositories } from '@rooster/db'
import { type Role, roleRank } from '@rooster/schema'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type Id, type InviteMemberInput, inviteMemberInput, type Membership, z } from './deps.js'

const upsertMemberInput = z.object({
  principalId: z.uuid(),
  teamId: z.uuid().nullable().default(null),
  role: z.enum(['viewer', 'member', 'admin', 'owner']),
})
export type UpsertMemberInput = z.infer<typeof upsertMemberInput>

export interface InviteResult {
  principalId: Id
  email: string
  role: string
  /** `created` = a new member user was provisioned; `updated` = role changed. */
  status: 'created' | 'updated'
}

/** A member of an org as shown in the dashboard: principal + role (+ email). */
export interface OrgMember {
  principalId: Id
  type: 'user' | 'agent'
  displayName: string
  email: string | null
  role: Role
}

export interface MemberService {
  /** Grant or change a principal's role (org-level or team-scoped). Admin-only. */
  upsert(actor: Actor, input: UpsertMemberInput): Promise<Membership>
  /**
   * Invite a human teammate by email into the actor's org (admin-only). A new
   * email provisions a member user (anchored to their account on first login);
   * an existing member in this org just has their role updated. An email that
   * already belongs to a *different* org is rejected — cross-org membership is
   * not supported yet (one user → one principal → one org).
   */
  invite(actor: Actor, input: InviteMemberInput): Promise<InviteResult>
  list(actor: Actor, principalId: Id): Promise<Membership[]>
  /** List every member of the actor's org with their (max) role. */
  listOrg(actor: Actor): Promise<OrgMember[]>
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

    async invite(actor, rawInput) {
      authorize(actor, 'team:write')
      const input = parse(inviteMemberInput, rawInput)

      const existing = await repos.users.getByEmail(input.email)
      if (existing) {
        const principal = await repos.principals.findById(existing.principalId)
        if (!principal || principal.orgId !== actor.orgId) {
          throw new ConflictError(
            `'${input.email}' already belongs to another workspace; cross-workspace membership is not supported yet`,
          )
        }
        await repos.memberships.upsert(actor.orgId, {
          principalId: principal.id,
          teamId: null,
          role: input.role,
        })
        await recordAudit(repos, actor, {
          action: 'membership.upsert',
          targetType: 'principal',
          targetId: principal.id,
          after: { role: input.role },
        })
        return {
          principalId: principal.id,
          email: input.email,
          role: input.role,
          status: 'updated',
        }
      }

      // New teammate: provision their principal + user (unanchored — their
      // account is linked on first MCP/dashboard login) and an org membership.
      const principal = await repos.principals.create(actor.orgId, {
        type: 'user',
        displayName: input.name ?? input.email,
      })
      await repos.users.create({
        principalId: principal.id,
        email: input.email,
        name: input.name ?? input.email,
        avatarUrl: null,
        authUserId: null,
      })
      await repos.memberships.upsert(actor.orgId, {
        principalId: principal.id,
        teamId: null,
        role: input.role,
      })
      await recordAudit(repos, actor, {
        action: 'member.invite',
        targetType: 'principal',
        targetId: principal.id,
        after: { email: input.email, role: input.role },
      })
      return { principalId: principal.id, email: input.email, role: input.role, status: 'created' }
    },

    async list(actor, principalId) {
      authorize(actor, 'agent:read')
      return repos.memberships.list(actor.orgId, principalId)
    },

    async listOrg(actor) {
      authorize(actor, 'agent:read')
      const [principals, memberships] = await Promise.all([
        repos.principals.listByOrg(actor.orgId, { limit: 200 }),
        repos.memberships.listByOrg(actor.orgId),
      ])
      // Each principal's effective role is the max across its memberships.
      const roleByPrincipal = new Map<string, Role>()
      for (const m of memberships) {
        const current = roleByPrincipal.get(m.principalId)
        if (!current || roleRank[m.role] > roleRank[current]) {
          roleByPrincipal.set(m.principalId, m.role)
        }
      }
      const members: OrgMember[] = []
      for (const p of principals) {
        const role = roleByPrincipal.get(p.id)
        if (!role) continue // a principal with no membership isn't a member
        const user = p.type === 'user' ? await repos.users.getByPrincipalId(p.id) : null
        members.push({
          principalId: p.id,
          type: p.type,
          displayName: p.displayName,
          email: user?.email ?? null,
          role,
        })
      }
      // Owners first, then by role rank descending, then name.
      members.sort(
        (a, b) => roleRank[b.role] - roleRank[a.role] || a.displayName.localeCompare(b.displayName),
      )
      return members
    },
  }
}
