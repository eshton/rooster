import { z } from 'zod'

/** Membership roles, ordered least → most privileged. */
export const ROLES = ['viewer', 'member', 'admin', 'owner'] as const
export const roleSchema = z.enum(ROLES)
export type Role = z.infer<typeof roleSchema>

/** Numeric privilege rank for a role (higher = more privileged). */
export const roleRank: Record<Role, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
}

/** The kind of principal acting in the system. */
export const PRINCIPAL_TYPES = ['user', 'agent'] as const
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES)
export type PrincipalType = z.infer<typeof principalTypeSchema>

/**
 * Self-reported agent runtime/kind. Open-ended by design ("custom" is the
 * escape hatch) — this is descriptive metadata, never used for authorization.
 */
export const AGENT_KINDS = ['claude-code', 'cursor', 'windsurf', 'custom'] as const
export const agentKindSchema = z.enum(AGENT_KINDS)
export type AgentKind = z.infer<typeof agentKindSchema>

/** Lifecycle status of a registered agent. */
export const AGENT_STATUSES = ['active', 'suspended', 'revoked'] as const
export const agentStatusSchema = z.enum(AGENT_STATUSES)
export type AgentStatus = z.infer<typeof agentStatusSchema>

/**
 * Default ticket workflow statuses. (Per-project configurable workflows are a
 * post-v1 open item — these are the built-in defaults.)
 */
export const TICKET_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
] as const
export const ticketStatusSchema = z.enum(TICKET_STATUSES)
export type TicketStatus = z.infer<typeof ticketStatusSchema>

/** Ticket priority. */
export const TICKET_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES)
export type TicketPriority = z.infer<typeof ticketPrioritySchema>

/**
 * Ticket effort estimate scale: Fibonacci **complexity points**.
 *
 * Estimation here is done mostly by *agents*, which (unlike a human team) share
 * no velocity baseline — so a freeform number would diverge between callers. A
 * fixed discrete scale anchored to objective signals makes estimates
 * reproducible: similarly-shaped work gets the same score regardless of who or
 * what estimates it. Score **complexity + uncertainty, not wall-clock time**
 * (estimator speed varies; complexity is intrinsic to the work). The full
 * rubric with worked examples lives in `docs/ESTIMATION.md`.
 */
export const ESTIMATE_POINTS = [1, 2, 3, 5, 8, 13] as const
export type EstimatePoints = (typeof ESTIMATE_POINTS)[number]

/**
 * Compact rubric surfaced in the MCP tool schema (via `.describe()`) so an
 * agent calling `create_ticket`/`update_ticket` reads the rules inline. Keep in
 * sync with `docs/ESTIMATION.md`.
 */
export const ESTIMATE_RUBRIC =
  'Effort estimate as Fibonacci COMPLEXITY points — one of 1, 2, 3, 5, 8, 13. ' +
  'Score complexity + uncertainty, NOT wall-clock time. ' +
  '1=trivial one-file mechanical change, existing pattern, no design choices. ' +
  '2=small, a few files in one layer, clear approach, no new abstractions. ' +
  '3=moderate, crosses a few layers following a documented pattern, a few edge cases. ' +
  '5=sizable, new component or cross-cutting change with some unknowns. ' +
  '8=large, new subsystem or many modules, real design work, broad test surface. ' +
  '13=epic or too uncertain to size — split into subtasks instead. ' +
  'The scale is ordinal (gaps widen on purpose); round UP when between two values. See docs/ESTIMATION.md.'

export const estimatePointsSchema = z
  .number()
  .refine((n): n is EstimatePoints => (ESTIMATE_POINTS as readonly number[]).includes(n), {
    message: `estimate must be one of ${ESTIMATE_POINTS.join(', ')} (Fibonacci complexity points; see docs/ESTIMATION.md)`,
  })
  .describe(ESTIMATE_RUBRIC)

/** Policy governing how new agents are admitted to an org. */
export const ENROLLMENT_POLICIES = ['token', 'approval', 'open'] as const
export const enrollmentPolicySchema = z.enum(ENROLLMENT_POLICIES)
export type EnrollmentPolicy = z.infer<typeof enrollmentPolicySchema>
