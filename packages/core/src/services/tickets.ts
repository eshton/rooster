import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
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
  type LinkTicketsInput,
  linkTicketsInput,
  type MoveTicketInput,
  moveTicketInput,
  type Ticket,
  type TicketLinkType,
  type TicketStatus,
  type UnlinkTicketsInput,
  type UpdateTicketInput,
  unlinkTicketsInput,
  updateTicketInput,
  z,
} from './deps.js'
import { emitToWatchers } from './watchers.js'

/** A ticket link seen from one ticket's perspective (inverse types resolved). */
export type RelatedRelation = 'blocks' | 'blocked_by' | 'relates' | 'duplicates' | 'duplicated_by'

export interface RelatedTicket {
  /** The relation from the queried ticket's point of view. */
  relation: RelatedRelation
  /** The ticket on the other end of the link. */
  ticketId: Id
  key: string
  title: string
}

/** Inverse relation labels for an incoming edge (relates is symmetric). */
const INVERSE_RELATION: Record<TicketLinkType, RelatedRelation> = {
  blocks: 'blocked_by',
  duplicates: 'duplicated_by',
  relates: 'relates',
}

/** Guard against runaway walks of the blocks graph on malformed data. */
const MAX_BLOCKS_DEPTH = 1000

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
  /** Create a directed relationship between two tickets (blocks/relates/duplicates). */
  link(actor: Actor, input: LinkTicketsInput): Promise<RelatedTicket>
  /** Remove a previously created link. */
  unlink(actor: Actor, input: UnlinkTicketsInput): Promise<{ removed: true }>
  /** List a ticket's relationships, resolved from that ticket's perspective. */
  listLinks(actor: Actor, ticketId: Id): Promise<RelatedTicket[]>
  /** Move a ticket to another project; it gets a fresh key + number there. */
  move(actor: Actor, input: MoveTicketInput): Promise<Ticket>
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

  /**
   * The `blocks` graph must stay acyclic: adding "from blocks to" is illegal if
   * `to` already (transitively) blocks `from`. Walks outgoing `blocks` edges
   * from `to` looking for `from`.
   */
  async function requireAcyclicBlocks(actor: Actor, fromId: Id, toId: Id): Promise<void> {
    const seen = new Set<Id>()
    let frontier: Id[] = [toId]
    for (let depth = 0; frontier.length && depth < MAX_BLOCKS_DEPTH; depth++) {
      const next: Id[] = []
      for (const nodeId of frontier) {
        if (seen.has(nodeId)) continue
        seen.add(nodeId)
        const links = await repos.ticketLinks.listForTicket(actor.orgId, nodeId)
        for (const l of links) {
          if (l.type !== 'blocks' || l.fromTicketId !== nodeId) continue
          if (l.toTicketId === fromId) {
            throw new ValidationError('Link would create a cycle in the blocks graph')
          }
          next.push(l.toTicketId)
        }
      }
      frontier = next
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
        startDate: input.startDate ?? null,
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

    async link(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(linkTicketsInput, rawInput)
      if (input.fromTicketId === input.toTicketId) {
        throw new ValidationError('A ticket cannot be linked to itself')
      }
      // Both ends must exist in this org (load throws NotFound otherwise).
      await load(actor, input.fromTicketId)
      const to = await load(actor, input.toTicketId)

      // Reject an exact duplicate; for the symmetric `relates`, also reject the
      // mirror edge so a pair is only related once.
      const existing = await repos.ticketLinks.find(
        actor.orgId,
        input.fromTicketId,
        input.toTicketId,
        input.type,
      )
      const mirror =
        input.type === 'relates'
          ? await repos.ticketLinks.find(
              actor.orgId,
              input.toTicketId,
              input.fromTicketId,
              'relates',
            )
          : null
      if (existing || mirror) {
        throw new ConflictError(`Tickets are already linked as '${input.type}'`)
      }

      if (input.type === 'blocks') {
        await requireAcyclicBlocks(actor, input.fromTicketId, input.toTicketId)
      }

      const created = await repos.ticketLinks.create(actor.orgId, {
        fromTicketId: input.fromTicketId,
        toTicketId: input.toTicketId,
        type: input.type,
      })
      await recordAudit(repos, actor, {
        action: 'ticket.link',
        targetType: 'ticket',
        targetId: input.fromTicketId,
        after: created,
      })
      return { relation: input.type, ticketId: to.id, key: to.key, title: to.title }
    },

    async unlink(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(unlinkTicketsInput, rawInput)
      const removed = await repos.ticketLinks.delete(
        actor.orgId,
        input.fromTicketId,
        input.toTicketId,
        input.type,
      )
      if (!removed) throw new NotFoundError('No such link to remove')
      await recordAudit(repos, actor, {
        action: 'ticket.unlink',
        targetType: 'ticket',
        targetId: input.fromTicketId,
        before: input,
      })
      return { removed: true }
    },

    async listLinks(actor, ticketId) {
      authorize(actor, 'ticket:read')
      await load(actor, ticketId) // 404 if the ticket isn't in this org
      const links = await repos.ticketLinks.listForTicket(actor.orgId, ticketId)
      const related: RelatedTicket[] = []
      for (const l of links) {
        const outgoing = l.fromTicketId === ticketId
        const otherId = outgoing ? l.toTicketId : l.fromTicketId
        const relation = outgoing ? l.type : INVERSE_RELATION[l.type]
        const other = await repos.tickets.getById(actor.orgId, otherId)
        if (!other) continue // tolerate a dangling endpoint
        related.push({ relation, ticketId: other.id, key: other.key, title: other.title })
      }
      return related
    },

    async move(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(moveTicketInput, rawInput)
      const before = await load(actor, input.ticketId)
      if (before.projectId === input.toProjectId) {
        throw new ValidationError('Ticket is already in that project')
      }

      const dest = await repos.projects.getById(actor.orgId, input.toProjectId)
      if (!dest) throw new NotFoundError(`Project ${input.toProjectId} not found`)
      if (!dest.key) throw new NotFoundError(`Project ${input.toProjectId} has no ticket key`)

      // Fresh number from the destination's (self-healing) sequence → new key.
      const number = await repos.tickets.nextNumber(actor.orgId, dest.id)
      const after = await repos.tickets.update(actor.orgId, input.ticketId, {
        projectId: dest.id,
        key: `${dest.key}-${number}`,
        number,
      })
      await recordAudit(repos, actor, {
        action: 'ticket.move',
        targetType: 'ticket',
        targetId: input.ticketId,
        before: { projectId: before.projectId, key: before.key },
        after: { projectId: after.projectId, key: after.key },
      })
      return after
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
      await emitToWatchers(repos, crowNotifier, actor, after, {
        kind: 'status',
        from: before.status,
        to: after.status,
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
      // The assignee follows their own work automatically.
      if (input.assigneeId) {
        await repos.watchers.add(actor.orgId, input.ticketId, input.assigneeId)
      }
      await recordAudit(repos, actor, {
        action: 'ticket.assign',
        targetType: 'ticket',
        targetId: input.ticketId,
        before: { assigneeId: before.assigneeId },
        after: { assigneeId: after.assigneeId },
      })
      await emitToWatchers(repos, crowNotifier, actor, after, {
        kind: 'assigned',
        assigneeId: after.assigneeId,
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
            kind: 'crow',
            orgId: actor.orgId,
            ticketId: ticket.id,
            ticketKey: ticket.key,
            title: ticket.title,
            assigneeId: ticket.assigneeId,
            byPrincipalId: actor.principalId,
            recipientIds: ticket.assigneeId ? [ticket.assigneeId] : [],
          })
        } catch {
          // best-effort delivery; the audited crow already succeeded
        }
      }
      return { ticket, assigneeId: ticket.assigneeId }
    },
  }
}
