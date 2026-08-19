import {
  CUSTOMER_LIFECYCLE_STAGES,
  type CustomerLifecycleStage,
  DEAL_PIPELINE_STAGES,
  type DealPipelineStage,
  TICKET_STATUSES,
  type TicketStatus,
} from '@rooster/schema'

/**
 * A generalized, named state-transition engine (ROO-53).
 *
 * Rooster runs several distinct state machines — ticket status, deal pipeline
 * stage, customer lifecycle stage — that previously each had a bespoke,
 * hardcoded transition graph. This module models them uniformly as
 * {@link Workflow}s so the validation logic is written once, per-kind DEFAULT
 * workflows preserve today's behavior exactly, and per-workspace configurable
 * pipelines can later be resolved through the same seam without touching
 * callers.
 */

/** The domain entity kinds that carry a configurable state machine. */
export type WorkflowKind = 'ticket' | 'deal' | 'customer'

/**
 * A named state machine over a fixed set of `stages`. `initial` is the stage a
 * freshly-created entity starts in; `transitions[s]` lists the stages reachable
 * in one step from `s`. Generic over the stage union so each kind stays
 * type-safe against its own enum.
 */
export interface Workflow<S extends string = string> {
  /** Identifier for this workflow (the built-ins are all `'default'`). */
  name: string
  kind: WorkflowKind
  /** Every stage in the machine (the enum's full set). */
  stages: readonly S[]
  /** The stage a newly-created entity starts in. */
  initial: S
  /** Adjacency map: `transitions[from]` = stages reachable from `from`. */
  transitions: Record<S, readonly S[]>
}

/** Whether `from → to` is a legal one-step move in `wf`. */
export function canTransitionIn<S extends string>(wf: Workflow<S>, from: S, to: S): boolean {
  return wf.transitions[from]?.includes(to) ?? false
}

/** The stages reachable from `from` in `wf` (for UIs and validation copy). */
export function allowedTransitionsIn<S extends string>(wf: Workflow<S>, from: S): readonly S[] {
  return wf.transitions[from] ?? []
}

/**
 * Built-in default ticket workflow. Byte-identical to the legacy
 * `TICKET_TRANSITIONS` graph — cancel reachable from any open state; done and
 * canceled can be reopened. Changing this changes ticket behavior globally.
 */
export const DEFAULT_TICKET_WORKFLOW: Workflow<TicketStatus> = {
  name: 'default',
  kind: 'ticket',
  stages: TICKET_STATUSES,
  initial: 'backlog',
  transitions: {
    backlog: ['todo', 'in_progress', 'canceled'],
    todo: ['backlog', 'in_progress', 'canceled'],
    in_progress: ['todo', 'in_review', 'done', 'canceled'],
    in_review: ['in_progress', 'done', 'canceled'],
    done: ['in_progress'],
    canceled: ['backlog', 'todo'],
  },
}

/**
 * Built-in default sales pipeline (ROO-48). Byte-identical to the legacy
 * `DEAL_TRANSITIONS` graph — `won`/`lost` reachable from late stages and can be
 * reopened.
 */
export const DEFAULT_DEAL_WORKFLOW: Workflow<DealPipelineStage> = {
  name: 'default',
  kind: 'deal',
  stages: DEAL_PIPELINE_STAGES,
  initial: 'prospecting',
  transitions: {
    prospecting: ['qualified', 'lost'],
    qualified: ['proposal', 'prospecting', 'lost'],
    proposal: ['won', 'lost', 'qualified'],
    won: ['proposal'],
    lost: ['prospecting', 'qualified'],
  },
}

/**
 * Built-in default customer lifecycle. A lead qualifies to a prospect, which
 * converts to active; any stage can churn, and a churned customer can be
 * re-engaged. Defined here for the generalized engine; enforcement on customer
 * mutations lands with a dedicated `change_lifecycle_stage` tool (today
 * `update_customer` still sets the stage directly).
 */
export const DEFAULT_CUSTOMER_WORKFLOW: Workflow<CustomerLifecycleStage> = {
  name: 'default',
  kind: 'customer',
  stages: CUSTOMER_LIFECYCLE_STAGES,
  initial: 'lead',
  transitions: {
    lead: ['prospect', 'churned'],
    prospect: ['active', 'lead', 'churned'],
    active: ['churned'],
    churned: ['lead', 'prospect', 'active'],
  },
}

/** The built-in default workflow for every entity kind, keyed by kind. */
export const DEFAULT_WORKFLOWS: Record<WorkflowKind, Workflow> = {
  ticket: DEFAULT_TICKET_WORKFLOW as Workflow,
  deal: DEFAULT_DEAL_WORKFLOW as Workflow,
  customer: DEFAULT_CUSTOMER_WORKFLOW as Workflow,
}

/**
 * The active workflow for an entity kind. Today it always returns the built-in
 * default; this is the seam where per-workspace / per-project persisted
 * overrides (a later slice of ROO-53) will resolve a custom workflow before
 * falling back to the default.
 */
export function getDefaultWorkflow(kind: WorkflowKind): Workflow {
  return DEFAULT_WORKFLOWS[kind]
}
