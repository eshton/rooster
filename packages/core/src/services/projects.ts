import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type ArchiveProjectInput,
  archiveProjectInput,
  type CreateProjectInput,
  createProjectInput,
  type DeleteProjectInput,
  deleteProjectInput,
  type Id,
  type MoveProjectInput,
  moveProjectInput,
  type Project,
  type SetProjectKeyInput,
  setProjectKeyInput,
} from './deps.js'

export interface ProjectService {
  create(actor: Actor, input: CreateProjectInput): Promise<Project>
  list(actor: Actor, teamId?: Id, opts?: ListOptions): Promise<Project[]>
  get(actor: Actor, id: Id): Promise<Project>
  /** Rename a project's ticket-key prefix, re-keying all its tickets in lockstep. */
  setKey(actor: Actor, input: SetProjectKeyInput): Promise<Project>
  /** Move a project to another team (metadata only; tickets/keys untouched). */
  move(actor: Actor, input: MoveProjectInput): Promise<Project>
  /** Archive or unarchive a project (reversible). */
  archive(actor: Actor, input: ArchiveProjectInput): Promise<Project>
  /** Permanently delete an empty project (no tickets). */
  delete(actor: Actor, input: DeleteProjectInput): Promise<{ deleted: true; id: Id }>
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

    async setKey(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(setProjectKeyInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (project.key === input.key) {
        throw new ValidationError(`Project key is already '${input.key}'`)
      }

      const others = await repos.projects.list(actor.orgId, undefined, { limit: 500 })
      if (others.some((p) => p.id !== project.id && p.key === input.key)) {
        throw new ConflictError(`Project key '${input.key}' is already used in this org`)
      }

      const updated = await repos.projects.update(actor.orgId, project.id, { key: input.key })
      // Re-key existing tickets in lockstep (numbers/sequence untouched, so no
      // collision). A previously keyless project has no consistent prefix to rewrite.
      if (project.key) {
        await repos.tickets.reKeyForProject(actor.orgId, project.id, project.key, input.key)
      }
      await recordAudit(repos, actor, {
        action: 'project.set_key',
        targetType: 'project',
        targetId: project.id,
        before: { key: project.key },
        after: { key: input.key },
      })
      return updated
    },

    async move(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(moveProjectInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (project.teamId === input.toTeamId) {
        throw new ValidationError('Project is already in that team')
      }

      const team = await repos.teams.getById(actor.orgId, input.toTeamId)
      if (!team) throw new NotFoundError(`Team ${input.toTeamId} not found`)

      // Numbering is per-project, so team membership is pure metadata — no
      // re-keying, no ticket touches. Just swap the column.
      const updated = await repos.projects.update(actor.orgId, project.id, {
        teamId: input.toTeamId,
      })
      await recordAudit(repos, actor, {
        action: 'project.move',
        targetType: 'project',
        targetId: project.id,
        before: { teamId: project.teamId },
        after: { teamId: input.toTeamId },
      })
      return updated
    },

    async archive(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(archiveProjectInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (project.archived === input.archived) {
        throw new ValidationError(`Project is already ${input.archived ? 'archived' : 'active'}`)
      }

      const updated = await repos.projects.update(actor.orgId, project.id, {
        archived: input.archived,
      })
      await recordAudit(repos, actor, {
        action: 'project.archive',
        targetType: 'project',
        targetId: project.id,
        before: { archived: project.archived },
        after: { archived: input.archived },
      })
      return updated
    },

    async delete(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(deleteProjectInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)

      // Only empty projects are deletable — tickets carry projectId with no DB
      // cascade, so a delete with tickets present would orphan them. Move or
      // delete the tickets first (or archive the project instead).
      const tickets = await repos.tickets.list(actor.orgId, project.id, { limit: 1 })
      if (tickets.length > 0) {
        throw new ConflictError(
          'Project still has tickets — move or delete them first, or archive the project instead',
        )
      }

      await repos.projects.delete(actor.orgId, project.id)
      await recordAudit(repos, actor, {
        action: 'project.delete',
        targetType: 'project',
        targetId: project.id,
        before: project,
      })
      return { deleted: true, id: project.id }
    },
  }
}
