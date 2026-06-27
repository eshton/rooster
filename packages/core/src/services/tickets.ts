import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError, ValidationError } from '../errors.js'
import type { CrowNotifier } from '../notify.js'
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
  type TicketStatus,
  type UpdateTicketInput,
  updateTicketInput,
  z,
} from './deps.js'

/** Optional server-side filters for {@link TicketService.list}. */
export interface TicketListFilter {
  status?: TicketStatus
  assigneeId?: Id
}

/** A ticket tag/label (same shape as a single entry of `ticket.labels`). */
const labelSchema = z.string().min(1).max(60)

/** Guard against runaway ancestry walks on pre-existing malformed data. */
const MAX_PARENT_DEPTH = 100

export interface TicketService {
  create(actor: Actor, input: CreateTicketInput): Promise<Ticket>
  get(actor: Actor, id: Id): Promise<Ticket>
  getByKey(actor: Actor, key: string): Promise<Ticket>
  list(actor: Actor, projectId: Id, opts?: ListOptions & TicketListFilter): Promise<Ticket[]>
  /** Tickets across the org assigned to the calling principal. */
  myTickets(actor: Actor, opts?: ListOptions): Promise<Ticket[]>
  /** Find related tickets across the org that carry a given tag. */
  findByLabel(actor: Actor, label: string, opts?: ListOptions): Promise<Ticket[]>
  /** Search tickets across the org by free text (title + description). */
  search(actor: Actor, query: string, opts?: ListOptions): Promise<Ticket[]>
  /** List the direct subtasks (children) of a ticket. */
  listSubtasks(actor: Actor, parentId: Id, opts?: ListOptions): Promise<Ticket[]>
  update(actor: Actor, id: Id, input: UpdateTicketInput): Promise<Ticket>
  changeStatus(actor: Actor, input: ChangeStatusInput): Promise<Ticket>
  assign(actor: Actor, input: AssignTicketInput): Promise<Ticket>
  /** Wake/notify the ticket's assignee (records an audited wake intent). */
  crow(actor: Actor, ticketId: Id): Promise<{ ticket: Ticket; assigneeId: Id | null }>
}

export function createTicketService(
  repos: Repositories,
  crowNotifier?: CrowNotifier,
): TicketService {
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

  /**
   * Validate that linking `ticketId` under `parentId` won't form a cycle: the
   * parent must exist, not be the ticket itself, and not be a descendant of it.
   */
  async function requireAcyclicParent(
    actor: Actor,
    ticketId: Id,
    parentId: Id | null,
  ): Promise<void> {
    if (parentId == null) return
    if (parentId === ticketId) {
      throw new ValidationError('A ticket cannot be its own parent')
    }
    let cursor: Id | null = parentId
    for (let depth = 0; cursor && depth < MAX_PARENT_DEPTH; depth++) {
      if (cursor === ticketId) {
        throw new ValidationError('Parent relationship would create a cycle')
      }
      const node: Ticket | null = await repos.tickets.getById(actor.orgId, cursor)
      if (!node) {
        if (cursor === parentId) throw new NotFoundError(`Parent ticket ${parentId} not found`)
        break
      }
      cursor = node.parentId
    }
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(createTicketInput, rawInput)

      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (!project.key) throw new NotFoundError(`Project ${input.projectId} has no ticket key`)

      await requireAssignee(actor, input.assigneeId ?? null)
      if (input.parentId != null) {
        const parent = await repos.tickets.getById(actor.orgId, input.parentId)
        if (!parent) throw new NotFoundError(`Parent ticket ${input.parentId} not found`)
      }

      // Ticket numbering is per-project, so keys read "<project key>-<n>".
      const number = await repos.tickets.nextNumber(actor.orgId, project.id)
      const ticket = await repos.tickets.create(actor.orgId, {
        projectId: input.projectId,
        key: `${project.key}-${number}`,
        number,
        title: input.title,
        description: input.description ?? null,
        status: INITIAL_TICKET_STATUS,
        priority: input.priority,
        labels: input.labels,
        assigneeId: input.assigneeId ?? null,
        parentId: input.parentId ?? null,
        dueDate: input.dueDate ?? null,
        estimate: input.estimate ?? null,
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

    async myTickets(actor, opts) {
      authorize(actor, 'ticket:read')
      return repos.tickets.listAssigned(actor.orgId, actor.principalId, opts)
    },

    async findByLabel(actor, rawLabel, opts) {
      authorize(actor, 'ticket:read')
      const label = parse(labelSchema, rawLabel)
      return repos.tickets.listByLabel(actor.orgId, label, opts)
    },

    async search(actor, rawQuery, opts) {
      authorize(actor, 'ticket:read')
      const query = parse(z.string().min(1).max(200), rawQuery)
      return repos.tickets.search(actor.orgId, query, opts)
    },

    async listSubtasks(actor, parentId, opts) {
      authorize(actor, 'ticket:read')
      await load(actor, parentId) // 404 if the parent doesn't exist in this org
      return repos.tickets.listChildren(actor.orgId, parentId, opts)
    },

    async update(actor, id, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(updateTicketInput, rawInput)
      const before = await load(actor, id)

      if ('assigneeId' in input) await requireAssignee(actor, input.assigneeId ?? null)
      if ('parentId' in input) await requireAcyclicParent(actor, id, input.parentId ?? null)

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

    async crow(actor, ticketId) {
      authorize(actor, 'ticket:write')
      const ticket = await load(actor, ticketId)
      // "crow" = wake/notify the ticket's assignee. The wake is always recorded
      // as an audited intent; if a notifier is wired, it is also delivered
      // out-of-band (best-effort — a delivery failure never fails the crow).
      await recordAudit(repos, actor, {
        action: 'ticket.crow',
        targetType: 'ticket',
        targetId: ticket.id,
        after: { assigneeId: ticket.assigneeId },
      })
      if (crowNotifier) {
        try {
          await crowNotifier.notify({
            orgId: actor.orgId,
            ticketId: ticket.id,
            ticketKey: ticket.key,
            title: ticket.title,
            assigneeId: ticket.assigneeId,
            byPrincipalId: actor.principalId,
          })
        } catch {
          // best-effort delivery; the audited crow already succeeded
        }
      }
      return { ticket, assigneeId: ticket.assigneeId }
    },
  }
}
