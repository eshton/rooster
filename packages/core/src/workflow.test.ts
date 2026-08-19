import { CUSTOMER_LIFECYCLE_STAGES, DEAL_PIPELINE_STAGES, TICKET_STATUSES } from '@rooster/schema'
import { describe, expect, it } from 'vitest'
import { DEAL_TRANSITIONS } from './deal-transitions.js'
import { TICKET_TRANSITIONS } from './transitions.js'
import {
  allowedTransitionsIn,
  canTransitionIn,
  DEFAULT_CUSTOMER_WORKFLOW,
  DEFAULT_DEAL_WORKFLOW,
  DEFAULT_TICKET_WORKFLOW,
  DEFAULT_WORKFLOWS,
  getDefaultWorkflow,
  type Workflow,
  type WorkflowKind,
} from './workflow.js'

describe('generalized workflow engine (ROO-53)', () => {
  it('canTransitionIn honours the adjacency map', () => {
    expect(canTransitionIn(DEFAULT_TICKET_WORKFLOW, 'backlog', 'todo')).toBe(true)
    expect(canTransitionIn(DEFAULT_TICKET_WORKFLOW, 'backlog', 'done')).toBe(false)
    expect(canTransitionIn(DEFAULT_DEAL_WORKFLOW, 'proposal', 'won')).toBe(true)
    expect(canTransitionIn(DEFAULT_DEAL_WORKFLOW, 'prospecting', 'won')).toBe(false)
    expect(canTransitionIn(DEFAULT_CUSTOMER_WORKFLOW, 'lead', 'prospect')).toBe(true)
    expect(canTransitionIn(DEFAULT_CUSTOMER_WORKFLOW, 'lead', 'active')).toBe(false)
  })

  it('allowedTransitionsIn returns the reachable set', () => {
    expect(allowedTransitionsIn(DEFAULT_TICKET_WORKFLOW, 'in_progress')).toEqual([
      'todo',
      'in_review',
      'done',
      'canceled',
    ])
    expect(allowedTransitionsIn(DEFAULT_CUSTOMER_WORKFLOW, 'churned')).toEqual([
      'lead',
      'prospect',
      'active',
    ])
  })

  it('every stage has a transition entry and initial is a real stage', () => {
    const wfs: Workflow[] = [
      DEFAULT_TICKET_WORKFLOW as Workflow,
      DEFAULT_DEAL_WORKFLOW as Workflow,
      DEFAULT_CUSTOMER_WORKFLOW as Workflow,
    ]
    for (const wf of wfs) {
      expect(wf.stages).toContain(wf.initial)
      for (const stage of wf.stages) {
        expect(wf.transitions[stage]).toBeDefined()
        // Reachable targets must themselves be declared stages.
        for (const to of wf.transitions[stage]) expect(wf.stages).toContain(to)
      }
    }
  })

  it('default workflows cover their full enum of stages', () => {
    expect([...DEFAULT_TICKET_WORKFLOW.stages]).toEqual([...TICKET_STATUSES])
    expect([...DEFAULT_DEAL_WORKFLOW.stages]).toEqual([...DEAL_PIPELINE_STAGES])
    expect([...DEFAULT_CUSTOMER_WORKFLOW.stages]).toEqual([...CUSTOMER_LIFECYCLE_STAGES])
  })

  it('getDefaultWorkflow resolves the right kind', () => {
    const kinds: WorkflowKind[] = ['ticket', 'deal', 'customer']
    for (const kind of kinds) {
      expect(getDefaultWorkflow(kind)).toBe(DEFAULT_WORKFLOWS[kind])
      expect(getDefaultWorkflow(kind).kind).toBe(kind)
    }
  })

  // Regression guard: the generalized defaults must stay byte-identical to the
  // legacy per-entity graphs, so no ticket/deal behavior drifts under ROO-53.
  it('preserves the legacy ticket and deal graphs exactly', () => {
    expect(DEFAULT_TICKET_WORKFLOW.transitions).toBe(TICKET_TRANSITIONS)
    expect(DEFAULT_DEAL_WORKFLOW.transitions).toBe(DEAL_TRANSITIONS)
  })
})
