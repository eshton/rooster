import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import type { CrowNotifier, NotificationEvent } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type Id,
  type Ticket,
  type Watcher,
  type WatchTicketInput,
  watchTicketInput,
} from './deps.js'

export interface WatcherService {
  /** Follow a ticket (idempotent). Returns the watcher row. */
  watch(actor: Actor, input: WatchTicketInput): Promise<Watcher>
  /** Unfollow a ticket. */
  unwatch(actor: Actor, input: WatchTicketInput): Promise<{ removed: boolean }>
  /** The principals watching a ticket. */
  listWatchers(actor: Actor, ticketId: Id): Promise<Watcher[]>
  /** Tickets the calling principal watches. */
  myWatches(actor: Actor, opts?: ListOptions): Promise<Ticket[]>
}

/**
 * Deliver a ticket-activity event to its watchers (minus the actor who caused
 * it), through the optional notifier. Best-effort: a delivery failure never
 * fails the originating mutation. Shared by the ticket + comment services.
 */
export async function emitToWatchers(
  repos: Repositories,
  notifier: CrowNotifier | undefined,
  actor: Actor,
  ticket: Pick<Ticket, 'id' | 'key' | 'title'>,
  event:
    | { kind: 'status'; from: string; to: string }
    | { kind: 'assigned'; assigneeId: string | null }
    | { kind: 'comment'; commentId: string },
): Promise<void> {
  if (!notifier) return
  const watchers = await repos.watchers.listForTicket(actor.orgId, ticket.id)
  const recipientIds = watchers.map((w) => w.principalId).filter((pid) => pid !== actor.principalId)
  if (recipientIds.length === 0) return
  const payload: NotificationEvent = {
    orgId: actor.orgId,
    ticketId: ticket.id,
    ticketKey: ticket.key,
    title: ticket.title,
    byPrincipalId: actor.principalId,
    recipientIds,
    ...event,
  }
  try {
    await notifier.notify(payload)
  } catch {
    // best-effort delivery; the mutation already succeeded
  }
}

export function createWatcherService(repos: Repositories): WatcherService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
    return ticket
  }

  return {
    async watch(actor, rawInput) {
      authorize(actor, 'ticket:read')
      const input = parse(watchTicketInput, rawInput)
      await requireTicket(actor, input.ticketId)
      const watcher = await repos.watchers.add(actor.orgId, input.ticketId, actor.principalId)
      await recordAudit(repos, actor, {
        action: 'ticket.watch',
        targetType: 'ticket',
        targetId: input.ticketId,
        after: { principalId: actor.principalId },
      })
      return watcher
    },

    async unwatch(actor, rawInput) {
      authorize(actor, 'ticket:read')
      const input = parse(watchTicketInput, rawInput)
      const removed = await repos.watchers.remove(actor.orgId, input.ticketId, actor.principalId)
      if (removed) {
        await recordAudit(repos, actor, {
          action: 'ticket.unwatch',
          targetType: 'ticket',
          targetId: input.ticketId,
          before: { principalId: actor.principalId },
        })
      }
      return { removed }
    },

    async listWatchers(actor, ticketId) {
      authorize(actor, 'ticket:read')
      await requireTicket(actor, ticketId)
      return repos.watchers.listForTicket(actor.orgId, ticketId)
    },

    async myWatches(actor, opts) {
      authorize(actor, 'ticket:read')
      const ids = await repos.watchers.listWatchedTicketIds(actor.orgId, actor.principalId, opts)
      const tickets = await Promise.all(ids.map((id) => repos.tickets.getById(actor.orgId, id)))
      return tickets.filter((t): t is Ticket => t !== null)
    },
  }
}
