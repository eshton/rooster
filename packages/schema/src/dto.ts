import { z } from 'zod'
import {
  agentKindSchema,
  enrollmentPolicySchema,
  ticketPrioritySchema,
  ticketStatusSchema,
} from './enums.js'
import { idSchema } from './ids.js'

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
  key: z
    .string()
    .min(2)
    .max(10)
    .regex(/^[A-Z][A-Z0-9]*$/),
  name: z.string().min(1).max(120),
})
export type CreateTeamInput = z.infer<typeof createTeamInput>

export const createProjectInput = z.object({
  teamId: idSchema,
  name: z.string().min(1).max(120),
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

// --- Agents -----------------------------------------------------------------

export const registerAgentInput = z.object({
  displayName: z.string().min(1).max(120),
  kind: agentKindSchema.default('custom'),
  vendor: z.string().max(120).optional(),
  version: z.string().max(60).optional(),
  scopes: z.array(z.string()).default([]),
  enrollmentToken: z.string().optional(),
})
export type RegisterAgentInput = z.infer<typeof registerAgentInput>

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
    key: z
      .string()
      .min(2)
      .max(10)
      .regex(/^[A-Z][A-Z0-9]*$/),
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
      .regex(/^[A-Z][A-Z0-9]*$/),
    name: z.string().min(1).max(120),
  }),
  project: z.object({
    name: z.string().min(1).max(120),
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
