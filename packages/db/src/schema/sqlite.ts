import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * SQLite / libSQL dialect schema.
 *
 * Portability conventions (kept identical in the Postgres schema so a single
 * repository implementation works across both dialects):
 *  - ids and timestamps are TEXT (app-generated UUIDs; ISO-8601 strings)
 *  - arrays / JSON blobs are TEXT (serialized in the repository layer)
 *  - booleans are integer(mode: 'boolean'), surfaced as JS booleans
 */

const id = () => text('id').primaryKey()
const createdAt = () => text('created_at').notNull()
const updatedAt = () => text('updated_at').notNull()

export const orgs = sqliteTable('orgs', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  enrollmentPolicy: text('enrollment_policy').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const teams = sqliteTable(
  'teams',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    // Optional team grouping key (the ticket prefix moved to projects).
    key: text('key'),
    name: text('name').notNull(),
    // Deprecated: ticket numbering is now per-project (projects.ticket_seq).
    ticketSeq: integer('ticket_seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('teams_org_key_uq').on(t.orgId, t.key)],
)

export const projects = sqliteTable(
  'projects',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    teamId: text('team_id').notNull(),
    // The ticket-key prefix for this project, unique per org.
    key: text('key'),
    name: text('name').notNull(),
    description: text('description'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    // Per-project ticket number sequence (atomically incremented on create).
    ticketSeq: integer('ticket_seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('projects_org_key_uq').on(t.orgId, t.key)],
)

export const principals = sqliteTable('principals', {
  id: id(),
  orgId: text('org_id').notNull(),
  type: text('type').notNull(),
  displayName: text('display_name').notNull(),
  // For `user`-type principals, the global account this principal belongs to.
  // One user (account) has one principal per org they're a member of, so this
  // is the link that makes cross-workspace membership possible. Null for agents.
  userId: text('user_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const users = sqliteTable('users', {
  id: id(),
  principalId: text('principal_id').notNull(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  authUserId: text('auth_user_id').unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const agents = sqliteTable('agents', {
  id: id(),
  principalId: text('principal_id').notNull(),
  orgId: text('org_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  displayName: text('display_name').notNull(),
  kind: text('kind').notNull(),
  vendor: text('vendor'),
  version: text('version'),
  oauthClientId: text('oauth_client_id').unique(),
  scopes: text('scopes').notNull().default('[]'),
  status: text('status').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const memberships = sqliteTable(
  'memberships',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id').notNull(),
    teamId: text('team_id'),
    role: text('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('memberships_scope_uq').on(t.orgId, t.principalId, t.teamId)],
)

export const tickets = sqliteTable(
  'tickets',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    key: text('key').notNull(),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    priority: text('priority').notNull(),
    labels: text('labels').notNull().default('[]'),
    assigneeId: text('assignee_id'),
    parentId: text('parent_id'),
    milestoneId: text('milestone_id'),
    dueDate: text('due_date'),
    startDate: text('start_date'),
    estimate: real('estimate'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('tickets_org_key_uq').on(t.orgId, t.key),
    // Hot read paths (board reads, filters, my_tickets, claim_next, milestone board).
    index('tickets_org_project_status_idx').on(t.orgId, t.projectId, t.status),
    index('tickets_org_assignee_idx').on(t.orgId, t.assigneeId),
    index('tickets_org_milestone_idx').on(t.orgId, t.milestoneId),
  ],
)

export const ticketLinks = sqliteTable(
  'ticket_links',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    fromTicketId: text('from_ticket_id').notNull(),
    toTicketId: text('to_ticket_id').notNull(),
    type: text('type').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ticket_links_uq').on(t.orgId, t.fromTicketId, t.toTicketId, t.type)],
)

export const invites = sqliteTable('invites', {
  id: id(),
  orgId: text('org_id').notNull(),
  code: text('code').notNull().unique(),
  role: text('role').notNull(),
  createdByPrincipalId: text('created_by_principal_id').notNull(),
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  expiresAt: text('expires_at'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const comments = sqliteTable(
  'comments',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    authorId: text('author_id').notNull(),
    body: text('body').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Backs list_comments / get_ticket_context per-ticket reads.
  (t) => [index('comments_org_ticket_idx').on(t.orgId, t.ticketId)],
)

export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    stage: text('stage').notNull(),
    authorId: text('author_id').notNull(),
    role: text('role').notNull(),
    kind: text('kind').notNull().default('text'),
    // Monotonic order within (org, ticket, stage); server-allocated.
    seq: integer('seq').notNull(),
    body: text('body').notNull(),
    // Optional JSON metadata (model/tool names, tokens…), encoded as TEXT.
    metadata: text('metadata'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Backs the staged per-ticket read (get_ticket_context / list_messages).
  (t) => [
    index('conversation_messages_org_ticket_stage_seq_idx').on(t.orgId, t.ticketId, t.stage, t.seq),
  ],
)

export const ticketAssignees = sqliteTable(
  'ticket_assignees',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    principalId: text('principal_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('ticket_assignees_uq').on(t.orgId, t.ticketId, t.principalId),
    // Backs my_tickets (co-assignee union) and claim-by-assignee lookups.
    index('ticket_assignees_org_principal_idx').on(t.orgId, t.principalId),
  ],
)

export const milestones = sqliteTable('milestones', {
  id: id(),
  orgId: text('org_id').notNull(),
  projectId: text('project_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  startDate: text('start_date'),
  dueDate: text('due_date'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const ticketWatchers = sqliteTable(
  'ticket_watchers',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    ticketId: text('ticket_id').notNull(),
    principalId: text('principal_id').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ticket_watchers_uq').on(t.orgId, t.ticketId, t.principalId)],
)

export const attachments = sqliteTable('attachments', {
  id: id(),
  orgId: text('org_id').notNull(),
  ticketId: text('ticket_id').notNull(),
  addedById: text('added_by_id').notNull(),
  url: text('url').notNull(),
  label: text('label'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  windowStart: text('window_start').notNull(),
  count: integer('count').notNull(),
})

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    // Client-supplied key, unique per org (the retry-dedup gate).
    key: text('key').notNull(),
    // The ticket created for this key (returned on a repeat).
    ticketId: text('ticket_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_keys_org_key_uq').on(t.orgId, t.key)],
)

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    before: text('before'),
    after: text('after'),
    clientInfo: text('client_info'),
    createdAt: createdAt(),
  },
  // Backs the audit viewer's reverse-chronological per-org list.
  (t) => [index('audit_log_org_created_idx').on(t.orgId, t.createdAt)],
)

export const sqliteSchema = {
  orgs,
  teams,
  projects,
  principals,
  users,
  agents,
  memberships,
  invites,
  tickets,
  ticketLinks,
  ticketWatchers,
  ticketAssignees,
  milestones,
  comments,
  conversationMessages,
  attachments,
  rateLimits,
  idempotencyKeys,
  auditLog,
}
