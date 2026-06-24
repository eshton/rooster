import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type CreateTeamInput, createTeamInput, type Id, type Team } from './deps.js'

export interface TeamService {
  create(actor: Actor, input: CreateTeamInput): Promise<Team>
  list(actor: Actor, opts?: ListOptions): Promise<Team[]>
  get(actor: Actor, id: Id): Promise<Team>
}

export function createTeamService(repos: Repositories): TeamService {
  return {
    async create(actor, rawInput) {
      authorize(actor, 'team:write')
      const input = parse(createTeamInput, rawInput)

      const existing = await repos.teams.list(actor.orgId, { limit: 200 })
      if (existing.some((t) => t.key === input.key)) {
        throw new ConflictError(`Team key '${input.key}' is already used in this org`)
      }

      const team = await repos.teams.create(actor.orgId, { key: input.key, name: input.name })
      await recordAudit(repos, actor, {
        action: 'team.create',
        targetType: 'team',
        targetId: team.id,
        after: team,
      })
      return team
    },

    async list(actor, opts) {
      authorize(actor, 'ticket:read')
      return repos.teams.list(actor.orgId, opts)
    },

    async get(actor, id) {
      authorize(actor, 'ticket:read')
      const team = await repos.teams.getById(actor.orgId, id)
      if (!team) throw new NotFoundError(`Team ${id} not found`)
      return team
    },
  }
}
