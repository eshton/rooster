import type { Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError } from '../errors.js'
import type { FounderAccount } from '../onboarding.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type CreateInviteInput,
  createInviteInput,
  type Invite,
  type JoinTenantInput,
  joinTenantInput,
  type Org,
} from './deps.js'

const DAY_MS = 86_400_000

export interface RedeemResult {
  org: Org
  role: string
  principalId: string
}

export interface InviteService {
  /** Mint a shareable join code for the actor's org (admin only). */
  create(actor: Actor, input: CreateInviteInput): Promise<Invite>
  /**
   * Redeem a join code for an authenticated, orgless account: provision their
   * principal + user (anchored to the account) and an org membership at the
   * code's role. Validates existence, expiry and remaining uses.
   */
  redeem(account: FounderAccount, input: JoinTenantInput): Promise<RedeemResult>
}

export function createInviteService(repos: Repositories): InviteService {
  function newCode(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'team:write')
      const input = parse(createInviteInput, rawInput)
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString()
        : null

      const invite = await repos.invites.create(actor.orgId, {
        code: newCode(),
        role: input.role,
        createdByPrincipalId: actor.principalId,
        maxUses: input.maxUses,
        expiresAt,
      })
      await recordAudit(repos, actor, {
        action: 'invite.create',
        targetType: 'invite',
        targetId: invite.id,
        after: { role: invite.role, maxUses: invite.maxUses, expiresAt },
      })
      return invite
    },

    async redeem(account, rawInput) {
      const { code } = parse(joinTenantInput, rawInput)
      const invite = await repos.invites.getByCode(code)
      if (!invite) throw new NotFoundError('Invalid invite code')
      if (invite.uses >= invite.maxUses)
        throw new ConflictError('This invite code has been used up')
      if (invite.expiresAt && invite.expiresAt < new Date().toISOString()) {
        throw new ConflictError('This invite code has expired')
      }

      const org = await repos.orgs.getById(invite.orgId)
      if (!org) throw new NotFoundError('Workspace no longer exists')

      // Resolve (or provision) the joining principal in the invite's org. One
      // global account has one principal per org it belongs to, so an existing
      // user joining a new workspace gets a fresh principal linked to the same
      // account (cross-workspace membership).
      let principalId: string
      const existing = await repos.users.getByEmail(account.email)
      if (existing) {
        if (existing.authUserId == null) {
          await repos.users.linkAuthUserId(existing.id, account.authUserId)
        }
        // Lazily back-link the user's home principal (covers rows created before
        // `principals.userId` existed) so the per-user lookup is complete.
        const home = await repos.principals.findById(existing.principalId)
        if (home && home.userId == null) {
          await repos.principals.linkUser(home.orgId, home.id, existing.id)
        }
        const mine = await repos.principals.listByUserId(existing.id)
        const inOrg = mine.find((p) => p.orgId === invite.orgId)
        principalId =
          inOrg?.id ??
          (
            await repos.principals.create(invite.orgId, {
              type: 'user',
              displayName: account.name || account.email,
              userId: existing.id,
            })
          ).id
      } else {
        const principal = await repos.principals.create(invite.orgId, {
          type: 'user',
          displayName: account.name || account.email,
        })
        const user = await repos.users.create({
          principalId: principal.id,
          email: account.email,
          name: account.name || account.email,
          avatarUrl: null,
          authUserId: account.authUserId,
        })
        await repos.principals.linkUser(invite.orgId, principal.id, user.id)
        principalId = principal.id
      }

      await repos.memberships.upsert(invite.orgId, { principalId, teamId: null, role: invite.role })
      await repos.invites.incrementUses(invite.orgId, invite.id)

      const joiner: Actor = {
        orgId: invite.orgId,
        principalId,
        type: 'user',
        role: invite.role,
        scopes: [],
        clientInfo: null,
      }
      await recordAudit(repos, joiner, {
        action: 'member.join',
        targetType: 'principal',
        targetId: principalId,
        after: { via: 'invite', inviteId: invite.id, role: invite.role },
      })
      return { org, role: invite.role, principalId }
    },
  }
}
