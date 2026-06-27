import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type CreateMilestoneInput, createMilestoneInput, type Id, type Milestone } from './deps.js'

export interface MilestoneService {
  /** Create a milestone/cycle in a project. */
  create(actor: Actor, input: CreateMilestoneInput): Promise<Milestone>
  /** List a project's milestones (most recent first). */
  list(actor: Actor, projectId: Id, opts?: ListOptions): Promise<Milestone[]>
}

export function createMilestoneService(repos: Repositories): MilestoneService {
  return {
    async create(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(createMilestoneInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)

      const milestone = await repos.milestones.create(actor.orgId, {
        projectId: input.projectId,
        name: input.name,
        description: input.description ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
      })
      await recordAudit(repos, actor, {
        action: 'milestone.create',
        targetType: 'milestone',
        targetId: milestone.id,
        after: milestone,
      })
      return milestone
    },

    async list(actor, projectId, opts) {
      authorize(actor, 'ticket:read')
      return repos.milestones.listForProject(actor.orgId, projectId, opts)
    },
  }
}
