import { type TicketStatus, ticketStatusSchema } from '@rooster/schema'
import { allowedTransitionsIn, canTransitionIn, DEFAULT_TICKET_WORKFLOW } from './workflow.js'

/**
 * The built-in default ticket workflow, kept here as named ticket-specific
 * helpers for existing callers. The graph itself now lives on
 * {@link DEFAULT_TICKET_WORKFLOW} (the generalized engine, ROO-53); these are
 * thin, type-narrowed wrappers over it so behavior is byte-identical.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> =
  DEFAULT_TICKET_WORKFLOW.transitions

/** The status assigned to a freshly created ticket. */
export const INITIAL_TICKET_STATUS: TicketStatus = DEFAULT_TICKET_WORKFLOW.initial

/**
 * Statuses a ticket may be in to be picked up by `claim_next` — actionable but
 * not yet started. (An in-progress/in-review ticket is already being worked.)
 */
export const CLAIMABLE_STATUSES: readonly TicketStatus[] = ['backlog', 'todo']

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return canTransitionIn(DEFAULT_TICKET_WORKFLOW, from, to)
}

/** The set of statuses reachable from `from` (for UIs and validation copy). */
export function allowedTransitions(from: TicketStatus): readonly TicketStatus[] {
  return allowedTransitionsIn(DEFAULT_TICKET_WORKFLOW, from)
}

export { ticketStatusSchema }
