/**
 * Outbound notification seam. The domain stays transport-agnostic: services
 * emit typed events to an injected notifier; the deployable wires a concrete
 * delivery (e.g. an HTTP webhook). Delivery is best-effort and must never fail
 * the originating action.
 *
 * Originally crow-only (wake a ticket's assignee); now also carries ticket
 * activity events (status / assignee / comment) delivered to a ticket's
 * watchers. The interface name is kept (`CrowNotifier`) for wiring stability.
 */

interface NotificationBase {
  orgId: string
  ticketId: string
  ticketKey: string
  title: string
  /** The principal who triggered the event. */
  byPrincipalId: string
  /**
   * Principals to notify: a ticket's watchers minus the actor (or, for `crow`,
   * the ticket's assignee). May be empty — delivery should then be a no-op.
   */
  recipientIds: string[]
}

/** A notification event delivered to the (optional) notifier. */
export type NotificationEvent =
  | (NotificationBase & { kind: 'crow'; assigneeId: string | null })
  | (NotificationBase & { kind: 'status'; from: string; to: string })
  | (NotificationBase & { kind: 'assigned'; assigneeId: string | null })
  | (NotificationBase & { kind: 'comment'; commentId: string })

/** The `crow` variant (retained as a named type for callers/tests). */
export type CrowEvent = Extract<NotificationEvent, { kind: 'crow' }>

export interface CrowNotifier {
  notify(event: NotificationEvent): Promise<void> | void
}

/** Optional dependencies injected into the service layer. */
export interface ServiceDeps {
  crowNotifier?: CrowNotifier
}
