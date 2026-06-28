import { z } from 'zod'
import {
  agentKindSchema,
  conversationStageSchema,
  enrollmentPolicySchema,
  estimatePointsSchema,
  messageKindSchema,
  messageRoleSchema,
  ticketLinkTypeSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
} from './enums.js'
import { idSchema, projectKeySchema } from './ids.js'

// --- Org / Team / Project ---------------------------------------------------

export const createOrgInput = z.object({
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1).max(120),
  enrollmentPolicy: enrollmentPolicySchema.default('token'),
})
export type CreateOrgInput = z.infer<typeof createOrgInput>

export const createTeamInput = z.object({
  // Teams no longer carry the ticket prefix (it lives on the project), so a key
  // is optional — provide one only if you want a team-level grouping key.
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/)
    .optional(),
  name: z.string().min(1).max(120),
})
export type CreateTeamInput = z.infer<typeof createTeamInput>

export const createProjectInput = z.object({
  teamId: idSchema,
  name: z.string().min(1).max(120),
  /** The ticket-key prefix for this project (unique per org). Prefer 3 chars. */
  key: projectKeySchema,
  description: z.string().max(4000).optional(),
})
export type CreateProjectInput = z.infer<typeof createProjectInput>

export const createMilestoneInput = z.object({
  projectId: idSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  /** Optional ISO-8601 start / due dates for the cycle. */
  startDate: z.string().max(40).nullable().optional(),
  dueDate: z.string().max(40).nullable().optional(),
})
export type CreateMilestoneInput = z.infer<typeof createMilestoneInput>

// --- Tickets ----------------------------------------------------------------

export const createTicketInput = z.object({
  projectId: idSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  priority: ticketPrioritySchema.default('none'),
  labels: z.array(z.string().min(1).max(60)).default([]),
  assigneeId: idSchema.optional(),
  parentId: idSchema.optional(),
  /** Optional milestone/cycle this ticket belongs to. */
  milestoneId: idSchema.nullable().optional(),
  /** Optional ISO-8601 due date (e.g. "2026-07-01" or a full datetime). */
  dueDate: z.string().max(40).nullable().optional(),
  /** Optional ISO-8601 planned start date. */
  startDate: z.string().max(40).nullable().optional(),
  /** Optional effort estimate as Fibonacci complexity points (see ESTIMATE_RUBRIC). */
  estimate: estimatePointsSchema.nullable().optional(),
  /**
   * Optional client-supplied idempotency key. The first create for a given
   * (org, key) is recorded; a repeat with the same key returns the original
   * ticket instead of creating a duplicate — so a retried/flaky call is safe.
   * Keys are scoped per workspace and retained (no expiry).
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
})
export type CreateTicketInput = z.infer<typeof createTicketInput>

/** Batch creation: open several tickets in one call (e.g. project bootstrap). */
export const createTicketsInput = z.object({
  tickets: z.array(createTicketInput).min(1).max(100),
})
export type CreateTicketsInput = z.infer<typeof createTicketsInput>

export const updateTicketInput = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(50_000).nullable(),
    priority: ticketPrioritySchema,
    labels: z.array(z.string().min(1).max(60)),
    assigneeId: idSchema.nullable(),
    parentId: idSchema.nullable(),
    milestoneId: idSchema.nullable(),
    dueDate: z.string().max(40).nullable(),
    startDate: z.string().max(40).nullable(),
    estimate: estimatePointsSchema.nullable(),
    /**
     * Optional optimistic-concurrency guard: the `updatedAt` the caller last saw.
     * When set, the write applies only if the ticket's current `updatedAt` still
     * matches; otherwise it fails with a Conflict (re-read and retry). Omit it to
     * keep last-write-wins. Not a ticket field — never written.
     */
    expectedUpdatedAt: z.string().max(40),
  })
  .partial()
export type UpdateTicketInput = z.infer<typeof updateTicketInput>

export const changeStatusInput = z.object({
  ticketId: idSchema,
  status: ticketStatusSchema,
  /** Optional optimistic-concurrency guard (see updateTicketInput). */
  expectedUpdatedAt: z.string().max(40).optional(),
})
export type ChangeStatusInput = z.infer<typeof changeStatusInput>

/**
 * Claim the next actionable ticket in a project. Selects the highest-priority,
 * oldest, unblocked, unassigned ticket and assigns it to the caller atomically.
 */
export const claimNextInput = z.object({
  projectId: idSchema,
})
export type ClaimNextInput = z.infer<typeof claimNextInput>

export const assignTicketInput = z.object({
  ticketId: idSchema,
  assigneeId: idSchema.nullable(),
  /** Optional optimistic-concurrency guard (see updateTicketInput). */
  expectedUpdatedAt: z.string().max(40).optional(),
})
export type AssignTicketInput = z.infer<typeof assignTicketInput>

export const commentInput = z.object({
  ticketId: idSchema,
  body: z.string().min(1).max(50_000),
})
export type CommentInput = z.infer<typeof commentInput>

/**
 * Append conversation messages to a ticket stage in one batch. The agent buffers
 * a stage's turns and flushes them in a single call (summarise tool output —
 * persist the curated trace, not raw spew). `seq` is server-allocated. A single
 * message is just the one-element case.
 */
export const appendMessagesInput = z.object({
  ticketId: idSchema,
  stage: conversationStageSchema,
  messages: z
    .array(
      z.object({
        role: messageRoleSchema,
        kind: messageKindSchema.default('text'),
        body: z.string().min(1).max(50_000),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
})
export type AppendMessagesInput = z.infer<typeof appendMessagesInput>

/** List a ticket's conversation messages, optionally filtered to one stage. */
export const listMessagesInput = z.object({
  ticketId: idSchema,
  stage: conversationStageSchema.optional(),
})
export type ListMessagesInput = z.infer<typeof listMessagesInput>

/**
 * Semantic recall over conversation messages across all projects in the org.
 * Optional `stage`/`role` narrow the match (e.g. only human `input` turns).
 */
export const recallConversationsInput = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(50).optional(),
  stage: conversationStageSchema.optional(),
  role: messageRoleSchema.optional(),
})
export type RecallConversationsInput = z.infer<typeof recallConversationsInput>

/**
 * Create or update a project context document. Omit `id` to create; pass it to
 * update an existing doc's name/body. `ticketId` pins it to a ticket (else
 * project-wide). The body is embedded for semantic recall.
 */
export const saveContextFileInput = z.object({
  id: idSchema.optional(),
  projectId: idSchema,
  ticketId: idSchema.nullable().optional(),
  name: z.string().min(1).max(200),
  body: z.string().min(1).max(100_000),
})
export type SaveContextFileInput = z.infer<typeof saveContextFileInput>

/** List a project's context files (optionally only those pinned to a ticket). */
export const listContextFilesInput = z.object({
  projectId: idSchema,
  ticketId: idSchema.optional(),
})
export type ListContextFilesInput = z.infer<typeof listContextFilesInput>

/**
 * Unified semantic recall across tickets, conversation messages and context
 * files in the org (cross-project). Returns heterogeneous, source-tagged hits.
 */
export const recallContextInput = z.object({
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(50).optional(),
})
export type RecallContextInput = z.infer<typeof recallContextInput>

/** Add or remove a co-assignee (shared ownership) on a ticket. */
export const assigneeRefInput = z.object({
  ticketId: idSchema,
  principalId: idSchema,
})
export type AssigneeRefInput = z.infer<typeof assigneeRefInput>

/** Follow / unfollow a ticket (subscribe to its activity notifications). */
export const watchTicketInput = z.object({ ticketId: idSchema })
export type WatchTicketInput = z.infer<typeof watchTicketInput>

/** Attach a link to a ticket. Files aren't hosted by Rooster — pass a URL. */
export const addAttachmentInput = z.object({
  ticketId: idSchema,
  url: z.url().max(2000),
  label: z.string().min(1).max(200).optional(),
})
export type AddAttachmentInput = z.infer<typeof addAttachmentInput>

/** Remove an attachment by its id. */
export const removeAttachmentInput = z.object({ attachmentId: idSchema })
export type RemoveAttachmentInput = z.infer<typeof removeAttachmentInput>

/** Create a directed relationship from one ticket to another. */
export const linkTicketsInput = z.object({
  fromTicketId: idSchema,
  toTicketId: idSchema,
  type: ticketLinkTypeSchema,
})
export type LinkTicketsInput = z.infer<typeof linkTicketsInput>

/** Remove a previously created link (identified by its from/to/type triple). */
export const unlinkTicketsInput = linkTicketsInput
export type UnlinkTicketsInput = LinkTicketsInput

/** Rename a project's ticket-key prefix (re-keys all its tickets in lockstep). */
export const setProjectKeyInput = z.object({
  projectId: idSchema,
  key: projectKeySchema,
})
export type SetProjectKeyInput = z.infer<typeof setProjectKeyInput>

/** Move a ticket to another project (it gets a fresh key + number there). */
export const moveTicketInput = z.object({
  ticketId: idSchema,
  toProjectId: idSchema,
})
export type MoveTicketInput = z.infer<typeof moveTicketInput>

// --- Agents -----------------------------------------------------------------

/**
 * Invite a human teammate into the org by email. If the email is new, a member
 * user is created and linked to their account on first login; an existing
 * member's role is updated. `role` defaults to `member`.
 */
export const inviteMemberInput = z.object({
  email: z.email(),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['viewer', 'member', 'admin']).default('member'),
})
export type InviteMemberInput = z.infer<typeof inviteMemberInput>

export const registerAgentInput = z.object({
  displayName: z.string().min(1).max(120),
  kind: agentKindSchema.default('custom'),
  vendor: z.string().max(120).optional(),
  version: z.string().max(60).optional(),
  scopes: z.array(z.string()).default([]),
  enrollmentToken: z.string().optional(),
})
export type RegisterAgentInput = z.infer<typeof registerAgentInput>

// --- Workspace join codes ---------------------------------------------------

/** Create a shareable join code (admin). `expiresInDays` omitted = no expiry. */
export const createInviteInput = z.object({
  role: z.enum(['viewer', 'member', 'admin']).default('member'),
  maxUses: z.number().int().min(1).max(1000).default(1),
  expiresInDays: z.number().int().min(1).max(365).optional(),
})
export type CreateInviteInput = z.infer<typeof createInviteInput>

/** Redeem a join code to join its workspace (called by an orgless account). */
export const joinTenantInput = z.object({
  code: z.string().min(8).max(64),
})
export type JoinTenantInput = z.infer<typeof joinTenantInput>

// --- Self-service tenant creation (over MCP) --------------------------------

/**
 * Create-a-workspace input for the `create_tenant` MCP tool. The caller is an
 * authenticated-but-orgless account; founder identity comes from the OAuth
 * token, so this asks only for the workspace name (slug derived when omitted)
 * and the first project's name + key (the ticket prefix, e.g. `ROOST`).
 */
export const createTenantInput = z.object({
  workspace: z.object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9][a-z0-9-]*$/)
      .optional(),
  }),
  project: z.object({
    name: z.string().min(1).max(120),
    key: projectKeySchema,
  }),
})
export type CreateTenantInput = z.infer<typeof createTenantInput>

// --- Tenant onboarding ------------------------------------------------------

/**
 * Agent-first, gated tenant self-registration: provision an org + team +
 * project and (optionally) a first owning agent in one call. `signupToken`
 * gates registration on a hosted instance (omit it when self-hosting open).
 */
export const registerTenantInput = z.object({
  signupToken: z.string().optional(),
  org: z.object({
    slug: z
      .string()
      .min(2)
      .max(48)
      .regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1).max(120),
    enrollmentPolicy: enrollmentPolicySchema.default('token'),
  }),
  founder: z.object({
    name: z.string().min(1).max(120),
    email: z.email(),
  }),
  team: z.object({
    key: z
      .string()
      .min(2)
      .max(10)
      .regex(/^[A-Z][A-Z0-9]*$/)
      .optional(),
    name: z.string().min(1).max(120),
  }),
  project: z.object({
    name: z.string().min(1).max(120),
    /** The ticket-key prefix for the first project (unique per org). Prefer 3 chars. */
    key: projectKeySchema,
    description: z.string().max(4000).optional(),
  }),
  agent: z
    .object({
      displayName: z.string().min(1).max(120),
      kind: agentKindSchema.default('custom'),
      scopes: z.array(z.string()).default([]),
      oauthClientId: z.string().min(1).optional(),
    })
    .optional(),
})
export type RegisterTenantInput = z.infer<typeof registerTenantInput>
