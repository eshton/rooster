import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type CreateProjectInput, createProjectInput, type Id, type Project } from './deps.js'

export interface ProjectService {
  create(actor: Actor, input: CreateProjectInput): Promise<Project>
  list(actor: Actor, teamId?: Id, opts?: ListOptions): Promise<Project[]>
  get(actor: Actor, id: Id): Promise<Project>
}

export function createProjectService(repos: Repositories): ProjectService {
  return {
    async create(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(createProjectInput, rawInput)

      const team = await repos.teams.getById(actor.orgId, input.teamId)
      if (!team) throw new NotFoundError(`Team ${input.teamId} not found`)

      // The project key is the ticket prefix and must be unique within the org.
      // On collision the caller should retry with a longer (4–5 char) key.
      const existing = await repos.projects.list(actor.orgId, undefined, { limit: 500 })
      if (existing.some((p) => p.key === input.key)) {
        throw new ConflictError(
          `Project key '${input.key}' is already used in this org — try a longer (4–5 char) key`,
        )
      }

      const project = await repos.projects.create(actor.orgId, {
        teamId: input.teamId,
        key: input.key,
        name: input.name,
        description: input.description ?? null,
        archived: false,
      })
      await recordAudit(repos, actor, {
        action: 'project.create',
        targetType: 'project',
        targetId: project.id,
        after: project,
      })
      return project
    },

    async list(actor, teamId, opts) {
      authorize(actor, 'ticket:read')
      return repos.projects.list(actor.orgId, teamId, opts)
    },

    async get(actor, id) {
      authorize(actor, 'ticket:read')
      const project = await repos.projects.getById(actor.orgId, id)
      if (!project) throw new NotFoundError(`Project ${id} not found`)
      return project
    },
  }
}
