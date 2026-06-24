import { timingSafeEqual } from 'node:crypto'
import type { AgentStatus, EnrollmentPolicy } from '@rooster/schema'

/**
 * Outcome of evaluating an org's enrollment policy against a registration
 * attempt. `admit` grants an active agent immediately; `pending` creates a
 * suspended agent awaiting human approval; `reject` denies registration.
 */
export type EnrollmentOutcome = 'admit' | 'pending' | 'reject'

export interface EnrollmentDecision {
  outcome: EnrollmentOutcome
  /** The initial status to assign a created agent (null when rejected). */
  initialStatus: AgentStatus | null
  reason: string
}

export interface EnrollmentAttempt {
  policy: EnrollmentPolicy
  /** Token presented by the registrant (for the `token` policy). */
  providedToken?: string | undefined
  /** Expected enrollment token configured for the org (for the `token` policy). */
  expectedToken?: string | undefined
}

/** Constant-time string comparison that never short-circuits on length. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) {
    // Still compare against self to keep timing uniform, then fail.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/**
 * Decide whether an agent may self-register, per the org enrollment policy
 * (secure-first: `token` requires a matching enrollment token, `approval`
 * parks the agent as suspended, only `open` admits freely).
 */
export function decideEnrollment(attempt: EnrollmentAttempt): EnrollmentDecision {
  switch (attempt.policy) {
    case 'open':
      return { outcome: 'admit', initialStatus: 'active', reason: 'Open enrollment policy' }

    case 'approval':
      return {
        outcome: 'pending',
        initialStatus: 'suspended',
        reason: 'Awaiting human approval',
      }

    case 'token': {
      if (!attempt.expectedToken) {
        return {
          outcome: 'reject',
          initialStatus: null,
          reason: 'No enrollment token configured for this org',
        }
      }
      if (!attempt.providedToken || !safeEqual(attempt.providedToken, attempt.expectedToken)) {
        return { outcome: 'reject', initialStatus: null, reason: 'Invalid enrollment token' }
      }
      return { outcome: 'admit', initialStatus: 'active', reason: 'Valid enrollment token' }
    }
  }
}
