import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ForbiddenError, NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type Agent,
  type AgentStatus,
  type Id,
  type RegisterAgentInput,
  registerAgentInput,
} from './deps.js'

export interface AgentService {
  /**
   * Register a new agent principal (admin-initiated). Creates the principal, the
   * agent row (status `active`, no OAuth client yet — DCR binding happens in the
   * auth layer) and an org-level `member` membership so the agent can act. The
   * enrollment-token / approval gating from the org policy is enforced by the
   * auth layer's self-registration flow.
   */
  register(actor: Actor, input: RegisterAgentInput): Promise<Agent>
  list(actor: Actor, opts?: ListOptions): Promise<Agent[]>
  get(actor: Actor, id: Id): Promise<Agent>
  setStatus(actor: Actor, id: Id, status: AgentStatus): Promise<Agent>
  /** Bind an agent to its OAuth client (1:1) so tokens resolve to it. */
  bindOAuthClient(actor: Actor, id: Id, oauthClientId: string): Promise<Agent>
}

export function createAgentService(repos: Repositories): AgentService {
  return {
    async register(actor, rawInput) {
      authorize(actor, 'agent:write')
      if (actor.type !== 'user') {
        throw new ForbiddenError('Only human principals may register agents')
      }
      const input = parse(registerAgentInput, rawInput)

      const owner = await repos.users.getByPrincipalId(actor.principalId)
      if (!owner) throw new ForbiddenError('Registering principal is not a user')

      const principal = await repos.principals.create(actor.orgId, {
        type: 'agent',
        displayName: input.displayName,
      })
      const agent = await repos.agents.create(actor.orgId, {
        principalId: principal.id,
        ownerUserId: owner.id,
        displayName: input.displayName,
        kind: input.kind,
        vendor: input.vendor ?? null,
        version: input.version ?? null,
        oauthClientId: null,
        scopes: input.scopes,
        status: 'active',
      })
      await repos.memberships.upsert(actor.orgId, {
        principalId: principal.id,
        teamId: null,
        role: 'member',
      })

      await recordAudit(repos, actor, {
        action: 'agent.register',
        targetType: 'agent',
        targetId: agent.id,
        after: agent,
      })
      return agent
    },

    async list(actor, opts) {
      authorize(actor, 'agent:read')
      return repos.agents.list(actor.orgId, opts)
    },

    async get(actor, id) {
      authorize(actor, 'agent:read')
      const agent = await repos.agents.getById(actor.orgId, id)
      if (!agent) throw new NotFoundError(`Agent ${id} not found`)
      return agent
    },

    async setStatus(actor, id, status) {
      authorize(actor, 'agent:write')
      const before = await repos.agents.getById(actor.orgId, id)
      if (!before) throw new NotFoundError(`Agent ${id} not found`)

      const after = await repos.agents.update(actor.orgId, id, { status })
      await recordAudit(repos, actor, {
        action: 'agent.set_status',
        targetType: 'agent',
        targetId: id,
        before: { status: before.status },
        after: { status: after.status },
      })
      return after
    },

    async bindOAuthClient(actor, id, oauthClientId) {
      authorize(actor, 'agent:write')
      const before = await repos.agents.getById(actor.orgId, id)
      if (!before) throw new NotFoundError(`Agent ${id} not found`)

      const after = await repos.agents.update(actor.orgId, id, { oauthClientId })
      await recordAudit(repos, actor, {
        action: 'agent.bind_client',
        targetType: 'agent',
        targetId: id,
        after: { oauthClientId },
      })
      return after
    },
  }
}
