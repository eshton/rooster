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

/** Policy governing how new agents are admitted to an org. */
export const ENROLLMENT_POLICIES = ['token', 'approval', 'open'] as const
export const enrollmentPolicySchema = z.enum(ENROLLMENT_POLICIES)
export type EnrollmentPolicy = z.infer<typeof enrollmentPolicySchema>
