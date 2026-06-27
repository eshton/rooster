import { z } from 'zod'
import {
  agentKindSchema,
  agentStatusSchema,
  enrollmentPolicySchema,
  estimatePointsSchema,
  principalTypeSchema,
  roleSchema,
  ticketLinkTypeSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
} from './enums.js'
import { idSchema, projectKeySchema, ticketKeySchema, timestampSchema } from './ids.js'

const base = {
  id: idSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}

/** Tenant root. Every other row is scoped by `orgId`. */
export const orgSchema = z.object({
  ...base,
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and hyphens only'),
  name: z.string().min(1).max(120),
  enrollmentPolicy: enrollmentPolicySchema,
})
export type Org = z.infer<typeof orgSchema>

export const teamSchema = z.object({
  ...base,
  orgId: idSchema,
  /**
   * Optional grouping key. Ticket prefixes now live on the **project**, so a
   * team no longer needs a key; the column is kept (nullable, unique per org
   * when set) for future per-team grouping.
   */
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/, 'Uppercase key, e.g. "ENG"')
    .nullable(),
  name: z.string().min(1).max(120),
})
export type Team = z.infer<typeof teamSchema>

export const projectSchema = z.object({
  ...base,
  orgId: idSchema,
  teamId: idSchema,
  /** The project's ticket-key prefix (unique per org); tickets are "<key>-<n>". */
  key: projectKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().max(4000).nullable(),
  archived: z.boolean(),
})
export type Project = z.infer<typeof projectSchema>

/**
 * A Principal is the shared supertype of User and Agent. Tickets are assigned
 * to, and audited against, a principal — so "which agent closed this?" is a
 * first-class query.
 */
export const principalSchema = z.object({
  ...base,
  orgId: idSchema,
  type: principalTypeSchema,
  displayName: z.string().min(1).max(120),
  /** For user-type principals, the global account they belong to (null for agents). */
  userId: idSchema.nullable().default(null),
})
export type Principal = z.infer<typeof principalSchema>

export const userSchema = z.object({
  ...base,
  principalId: idSchema,
  email: z.email(),
  name: z.string().min(1).max(120),
  avatarUrl: z.url().nullable(),
  /**
   * The better-auth account id (`getMcpSession().userId`) this Rooster user is
   * anchored to. Stable across a human's OAuth clients (Claude, opencode, …) so
   * every client of the same account maps to the same tenant. Null for users
   * created before the account link (lazily backfilled on first MCP call).
   */
  authUserId: z.string().min(1).nullable().default(null),
})
export type User = z.infer<typeof userSchema>

/**
 * An Agent is an AI principal backed 1:1 by an OAuth client. The trusted
 * identity is `id` (bound into every issued token). `kind`/`vendor`/`version`
 * are self-reported descriptive metadata and MUST NOT drive authorization.
 */
export const agentSchema = z.object({
  ...base,
  principalId: idSchema,
  orgId: idSchema,
  ownerUserId: idSchema,
  displayName: z.string().min(1).max(120),
  kind: agentKindSchema,
  vendor: z.string().max(120).nullable(),
  version: z.string().max(60).nullable(),
  oauthClientId: z.string().min(1).nullable(),
  scopes: z.array(z.string()),
  status: agentStatusSchema,
})
export type Agent = z.infer<typeof agentSchema>

export const membershipSchema = z.object({
  ...base,
  orgId: idSchema,
  principalId: idSchema,
  /** null = org-level membership; set = scoped to a single team. */
  teamId: idSchema.nullable(),
  role: roleSchema,
})
export type Membership = z.infer<typeof membershipSchema>

export const ticketSchema = z.object({
  ...base,
  orgId: idSchema,
  projectId: idSchema,
  key: ticketKeySchema,
  number: z.number().int().positive(),
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).nullable(),
  status: ticketStatusSchema,
  priority: ticketPrioritySchema,
  labels: z.array(z.string().min(1).max(60)),
  assigneeId: idSchema.nullable(),
  parentId: idSchema.nullable(),
  /** Optional ISO-8601 due date/deadline (date or datetime); null = none. */
  dueDate: z.string().max(40).nullable(),
  /** Optional effort estimate as Fibonacci complexity points; null = unsized. */
  estimate: estimatePointsSchema.nullable(),
})
export type Ticket = z.infer<typeof ticketSchema>

/**
 * A directed relationship between two tickets in the same org (see
 * `ticketLinkTypeSchema`). Distinct from `parentId` (subtask hierarchy).
 */
export const ticketLinkSchema = z.object({
  ...base,
  orgId: idSchema,
  fromTicketId: idSchema,
  toTicketId: idSchema,
  type: ticketLinkTypeSchema,
})
export type TicketLink = z.infer<typeof ticketLinkSchema>

export const commentSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  authorId: idSchema,
  body: z.string().min(1).max(50_000),
})
export type Comment = z.infer<typeof commentSchema>

/**
 * A shareable workspace join code. An orgless account redeems it to join the
 * org at `role`. Bounded by `maxUses` and an optional `expiresAt`.
 */
export const inviteSchema = z.object({
  ...base,
  orgId: idSchema,
  code: z.string().min(8).max(64),
  role: roleSchema,
  createdByPrincipalId: idSchema,
  maxUses: z.number().int().positive(),
  uses: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
})
export type Invite = z.infer<typeof inviteSchema>

/**
 * Self-reported MCP client metadata captured from the `initialize` request.
 * Untrusted — stored only as an audit snapshot, never used for authorization.
 */
export const clientInfoSchema = z.object({
  name: z.string().max(200),
  version: z.string().max(60),
})
export type ClientInfo = z.infer<typeof clientInfoSchema>

/**
 * Append-only audit record. Every mutating action is attributed to the trusted
 * `principalId`, with an optional untrusted `clientInfo` snapshot for display.
 */
export const auditLogSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  principalId: idSchema,
  action: z.string().min(1).max(120),
  targetType: z.string().min(1).max(60),
  targetId: idSchema.nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  clientInfo: clientInfoSchema.nullable(),
  createdAt: timestampSchema,
})
export type AuditLog = z.infer<typeof auditLogSchema>
