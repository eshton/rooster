import { type TicketStatus, ticketStatusSchema } from '@rooster/schema'

/**
 * Allowed ticket status transitions (the built-in default workflow). Cancel is
 * reachable from any open state; done and canceled can be reopened. Per-project
 * configurable workflows are a documented post-v1 item.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  backlog: ['todo', 'in_progress', 'canceled'],
  todo: ['backlog', 'in_progress', 'canceled'],
  in_progress: ['todo', 'in_review', 'done', 'canceled'],
  in_review: ['in_progress', 'done', 'canceled'],
  done: ['in_progress'],
  canceled: ['backlog', 'todo'],
}

/** The status assigned to a freshly created ticket. */
export const INITIAL_TICKET_STATUS: TicketStatus = 'backlog'

/**
 * Statuses a ticket may be in to be picked up by `claim_next` — actionable but
 * not yet started. (An in-progress/in-review ticket is already being worked.)
 */
export const CLAIMABLE_STATUSES: readonly TicketStatus[] = ['backlog', 'todo']

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to)
}

/** The set of statuses reachable from `from` (for UIs and validation copy). */
export function allowedTransitions(from: TicketStatus): readonly TicketStatus[] {
  return TICKET_TRANSITIONS[from]
}

export { ticketStatusSchema }
