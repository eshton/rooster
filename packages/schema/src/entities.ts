import { z } from 'zod'
import {
  agentKindSchema,
  agentStatusSchema,
  conversationStageSchema,
  enrollmentPolicySchema,
  estimatePointsSchema,
  messageKindSchema,
  messageRoleSchema,
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
  /** Optional milestone/cycle this ticket belongs to; null = none. */
  milestoneId: idSchema.nullable(),
  /** Optional ISO-8601 due date/deadline (date or datetime); null = none. */
  dueDate: z.string().max(40).nullable(),
  /** Optional ISO-8601 planned start date; null = none. */
  startDate: z.string().max(40).nullable(),
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

/**
 * A link attached to a ticket (logs, designs, docs). Stored as a URL + optional
 * label — Rooster does not host files; an attachment always references a
 * resource by URL. A future direct-upload path would store the blob in
 * platform object storage and record the resulting URL here, so this shape is
 * forward-compatible.
 */
export const attachmentSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  /** Principal who attached it. */
  addedById: idSchema,
  url: z.url().max(2000),
  label: z.string().max(200).nullable(),
})
export type Attachment = z.infer<typeof attachmentSchema>

export const commentSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  authorId: idSchema,
  body: z.string().min(1).max(50_000),
})
export type Comment = z.infer<typeof commentSchema>

/**
 * A single message in a ticket's conversation trace — one turn of the human↔agent
 * collaboration, tagged with the workflow `stage` it belongs to. Distinct from
 * `comment` (a flat human-facing thread): messages are stage-aware, role-tagged,
 * ordered within a stage by `seq`, and carry optional structured `metadata`.
 * `authorId` is the trusted attribution; `role` and `metadata` are descriptive
 * (untrusted), never used for authorization — like the audit log's `clientInfo`.
 */
export const conversationMessageSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  stage: conversationStageSchema,
  /** Principal (human or agent) who authored the message — trusted. */
  authorId: idSchema,
  role: messageRoleSchema,
  kind: messageKindSchema,
  /** Monotonic order within (ticketId, stage); server-allocated. */
  seq: z.number().int().nonnegative(),
  body: z.string().min(1).max(50_000),
  /** Optional structured metadata (agent/model/tool names, tokens…). Untrusted. */
  metadata: z.unknown().nullable(),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

/**
 * A named context document attached to a project (and optionally pinned to a
 * ticket). Unlike `attachment` (which stores only a URL — Rooster does not host
 * files), a context file stores its text **in-row**: the whole point is to embed
 * it for semantic recall, so the content must live in the database.
 */
export const contextFileSchema = z.object({
  ...base,
  orgId: idSchema,
  projectId: idSchema,
  /** Optional ticket this doc is pinned to; null = project-wide. */
  ticketId: idSchema.nullable(),
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
  /** Principal who saved it. */
  authorId: idSchema,
})
export type ContextFile = z.infer<typeof contextFileSchema>

/** A milestone / cycle (sprint): a named, optionally time-boxed grouping of
 * tickets within a project. */
export const milestoneSchema = z.object({
  ...base,
  orgId: idSchema,
  projectId: idSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  /** Optional ISO-8601 start date / due date for the cycle. */
  startDate: z.string().max(40).nullable(),
  dueDate: z.string().max(40).nullable(),
})
export type Milestone = z.infer<typeof milestoneSchema>

/** A co-assignee of a ticket (shared ownership beyond the primary assigneeId). */
export const ticketAssigneeSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  principalId: idSchema,
})
export type TicketAssignee = z.infer<typeof ticketAssigneeSchema>

/** A principal following a ticket — notified on status/assignee/comment changes. */
export const watcherSchema = z.object({
  ...base,
  orgId: idSchema,
  ticketId: idSchema,
  principalId: idSchema,
})
export type Watcher = z.infer<typeof watcherSchema>

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
