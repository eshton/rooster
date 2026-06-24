import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError, ValidationError } from '../errors.js'
import { authorize } from '../permissions.js'
import { canTransition, INITIAL_TICKET_STATUS } from '../transitions.js'
import { parse } from '../validate.js'
import {
  type AssignTicketInput,
  assignTicketInput,
  type ChangeStatusInput,
  type CreateTicketInput,
  changeStatusInput,
  createTicketInput,
  type Id,
  type Ticket,
  type UpdateTicketInput,
  updateTicketInput,
} from './deps.js'

export interface TicketService {
  create(actor: Actor, input: CreateTicketInput): Promise<Ticket>
  get(actor: Actor, id: Id): Promise<Ticket>
  getByKey(actor: Actor, key: string): Promise<Ticket>
  list(actor: Actor, projectId: Id, opts?: ListOptions): Promise<Ticket[]>
  update(actor: Actor, id: Id, input: UpdateTicketInput): Promise<Ticket>
  changeStatus(actor: Actor, input: ChangeStatusInput): Promise<Ticket>
  assign(actor: Actor, input: AssignTicketInput): Promise<Ticket>
}

export function createTicketService(repos: Repositories): TicketService {
  /** Ensure an assignee principal exists in this org (or is being cleared). */
  async function requireAssignee(actor: Actor, assigneeId: Id | null): Promise<void> {
    if (assigneeId == null) return
    const principal = await repos.principals.getById(actor.orgId, assigneeId)
    if (!principal) throw new NotFoundError(`Assignee principal ${assigneeId} not found`)
  }

  async function load(actor: Actor, id: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, id)
    if (!ticket) throw new NotFoundError(`Ticket ${id} not found`)
    return ticket
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(createTicketInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      const team = await repos.teams.getById(actor.orgId, project.teamId)
      if (!team) throw new NotFoundError(`Team ${project.teamId} not found`)

      await requireAssignee(actor, input.assigneeId ?? null)
      if (input.parentId != null) {
        const parent = await repos.tickets.getById(actor.orgId, input.parentId)
        if (!parent) throw new NotFoundError(`Parent ticket ${input.parentId} not found`)
      }

      const number = await repos.tickets.nextNumber(actor.orgId, team.id)
      const ticket = await repos.tickets.create(actor.orgId, {
        projectId: input.projectId,
        key: `${team.key}-${number}`,
        number,
        title: input.title,
        description: input.description ?? null,
        status: INITIAL_TICKET_STATUS,
        priority: input.priority,
        labels: input.labels,
        assigneeId: input.assigneeId ?? null,
        parentId: input.parentId ?? null,
      })

      await recordAudit(repos, actor, {
        action: 'ticket.create',
        targetType: 'ticket',
        targetId: ticket.id,
        after: ticket,
      })
      return ticket
    },

    async get(actor, id) {
      authorize(actor, 'ticket:read')
      return load(actor, id)
    },

    async getByKey(actor, key) {
      authorize(actor, 'ticket:read')
      const ticket = await repos.tickets.getByKey(actor.orgId, key)
      if (!ticket) throw new NotFoundError(`Ticket ${key} not found`)
      return ticket
    },

    async list(actor, projectId, opts) {
      authorize(actor, 'ticket:read')
      return repos.tickets.list(actor.orgId, projectId, opts)
    },

    async update(actor, id, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(updateTicketInput, rawInput)
      const before = await load(actor, id)

      if ('assigneeId' in input) await requireAssignee(actor, input.assigneeId ?? null)

      const after = await repos.tickets.update(actor.orgId, id, input)
      await recordAudit(repos, actor, {
        action: 'ticket.update',
        targetType: 'ticket',
        targetId: id,
        before,
        after,
      })
      return after
    },

    async changeStatus(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(changeStatusInput, rawInput)
      const before = await load(actor, input.ticketId)

      if (before.status === input.status) {
        throw new ValidationError(`Ticket is already '${input.status}'`)
      }
      if (!canTransition(before.status, input.status)) {
        throw new ValidationError(`Illegal transition '${before.status}' → '${input.status}'`)
      }

      const after = await repos.tickets.update(actor.orgId, input.ticketId, {
        status: input.status,
      })
      await recordAudit(repos, actor, {
        action: 'ticket.change_status',
        targetType: 'ticket',
        targetId: input.ticketId,
        before: { status: before.status },
        after: { status: after.status },
      })
      return after
    },

    async assign(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(assignTicketInput, rawInput)
      const before = await load(actor, input.ticketId)
      await requireAssignee(actor, input.assigneeId)

      const after = await repos.tickets.update(actor.orgId, input.ticketId, {
        assigneeId: input.assigneeId,
      })
      await recordAudit(repos, actor, {
        action: 'ticket.assign',
        targetType: 'ticket',
        targetId: input.ticketId,
        before: { assigneeId: before.assigneeId },
        after: { assigneeId: after.assigneeId },
      })
      return after
    },
  }
}
