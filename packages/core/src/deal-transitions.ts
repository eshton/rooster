import { type DealPipelineStage, dealPipelineStageSchema } from '@rooster/schema'
import { allowedTransitionsIn, canTransitionIn, DEFAULT_DEAL_WORKFLOW } from './workflow.js'

/**
 * The built-in default sales pipeline (ROO-48), kept here as named
 * deal-specific helpers for existing callers. The graph itself now lives on
 * {@link DEFAULT_DEAL_WORKFLOW} (the generalized engine, ROO-53); these are
 * thin, type-narrowed wrappers over it so behavior is byte-identical.
 */
export const DEAL_TRANSITIONS: Record<DealPipelineStage, readonly DealPipelineStage[]> =
  DEFAULT_DEAL_WORKFLOW.transitions

/** The stage a freshly opened deal starts in. */
export const INITIAL_DEAL_STAGE: DealPipelineStage = DEFAULT_DEAL_WORKFLOW.initial

export function canDealTransition(from: DealPipelineStage, to: DealPipelineStage): boolean {
  return canTransitionIn(DEFAULT_DEAL_WORKFLOW, from, to)
}

/** Stages reachable from `from` (for UIs and validation copy). */
export function allowedDealTransitions(from: DealPipelineStage): readonly DealPipelineStage[] {
  return allowedTransitionsIn(DEFAULT_DEAL_WORKFLOW, from)
}

export { dealPipelineStageSchema }
