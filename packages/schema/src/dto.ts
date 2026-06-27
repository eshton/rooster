import { z } from 'zod'
import {
  agentKindSchema,
  enrollmentPolicySchema,
  estimatePointsSchema,
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

// --- Tickets ----------------------------------------------------------------

export const createTicketInput = z.object({
  projectId: idSchema,
  title: z.string().min(1).max(300),
  description: z.string().max(50_000).optional(),
  priority: ticketPrioritySchema.default('none'),
  labels: z.array(z.string().min(1).max(60)).default([]),
  assigneeId: idSchema.optional(),
  parentId: idSchema.optional(),
  /** Optional ISO-8601 due date (e.g. "2026-07-01" or a full datetime). */
  dueDate: z.string().max(40).nullable().optional(),
  /** Optional effort estimate as Fibonacci complexity points (see ESTIMATE_RUBRIC). */
  estimate: estimatePointsSchema.nullable().optional(),
})
export type CreateTicketInput = z.infer<typeof createTicketInput>

export const updateTicketInput = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(50_000).nullable(),
    priority: ticketPrioritySchema,
    labels: z.array(z.string().min(1).max(60)),
    assigneeId: idSchema.nullable(),
    parentId: idSchema.nullable(),
    dueDate: z.string().max(40).nullable(),
    estimate: estimatePointsSchema.nullable(),
  })
  .partial()
export type UpdateTicketInput = z.infer<typeof updateTicketInput>

export const changeStatusInput = z.object({
  ticketId: idSchema,
  status: ticketStatusSchema,
})
export type ChangeStatusInput = z.infer<typeof changeStatusInput>

export const assignTicketInput = z.object({
  ticketId: idSchema,
  assigneeId: idSchema.nullable(),
})
export type AssignTicketInput = z.infer<typeof assignTicketInput>

export const commentInput = z.object({
  ticketId: idSchema,
  body: z.string().min(1).max(50_000),
})
export type CommentInput = z.infer<typeof commentInput>

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
