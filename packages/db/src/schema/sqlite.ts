import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

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
    key: text('key').notNull(),
    name: text('name').notNull(),
    ticketSeq: integer('ticket_seq').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('teams_org_key_uq').on(t.orgId, t.key)],
)

export const projects = sqliteTable('projects', {
  id: id(),
  orgId: text('org_id').notNull(),
  teamId: text('team_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const principals = sqliteTable('principals', {
  id: id(),
  orgId: text('org_id').notNull(),
  type: text('type').notNull(),
  displayName: text('display_name').notNull(),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tickets_org_key_uq').on(t.orgId, t.key)],
)

export const comments = sqliteTable('comments', {
  id: id(),
  orgId: text('org_id').notNull(),
  ticketId: text('ticket_id').notNull(),
  authorId: text('author_id').notNull(),
  body: text('body').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const auditLog = sqliteTable('audit_log', {
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
})

export const sqliteSchema = {
  orgs,
  teams,
  projects,
  principals,
  users,
  agents,
  memberships,
  tickets,
  comments,
  auditLog,
}
