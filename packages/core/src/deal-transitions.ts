import { type DealPipelineStage, dealPipelineStageSchema } from '@rooster/schema'

/**
 * Allowed deal pipeline transitions — the built-in DEFAULT sales pipeline
 * (ROO-48). A second state machine, distinct from ticket status and the customer
 * lifecycle. `won`/`lost` are reachable from late stages and can be reopened.
 * Per-workspace configurable pipelines ride the generalized workflow engine
 * (ROO-53); this module is its default and the seam to generalize.
 */
export const DEAL_TRANSITIONS: Record<DealPipelineStage, readonly DealPipelineStage[]> = {
  prospecting: ['qualified', 'lost'],
  qualified: ['proposal', 'prospecting', 'lost'],
  proposal: ['won', 'lost', 'qualified'],
  won: ['proposal'],
  lost: ['prospecting', 'qualified'],
}

/** The stage a freshly opened deal starts in. */
export const INITIAL_DEAL_STAGE: DealPipelineStage = 'prospecting'

export function canDealTransition(from: DealPipelineStage, to: DealPipelineStage): boolean {
  return DEAL_TRANSITIONS[from].includes(to)
}

/** Stages reachable from `from` (for UIs and validation copy). */
export function allowedDealTransitions(from: DealPipelineStage): readonly DealPipelineStage[] {
  return DEAL_TRANSITIONS[from]
}

export { dealPipelineStageSchema }
