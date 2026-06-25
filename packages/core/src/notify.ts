/**
 * Outbound notification seam. The domain stays transport-agnostic: services
 * emit typed events to an injected {@link CrowNotifier}; the deployable wires a
 * concrete delivery (e.g. an HTTP webhook). Delivery is best-effort and must
 * never fail the originating action.
 */

/** Emitted when a ticket's assignee is "crowed" (woken/notified). */
export interface CrowEvent {
  orgId: string
  ticketId: string
  ticketKey: string
  title: string
  assigneeId: string | null
  /** The principal who issued the crow. */
  byPrincipalId: string
}

export interface CrowNotifier {
  notify(event: CrowEvent): Promise<void> | void
}

/** Optional dependencies injected into the service layer. */
export interface ServiceDeps {
  crowNotifier?: CrowNotifier
}
