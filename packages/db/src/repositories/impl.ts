import type {
  Agent,
  AuditLog,
  ClientInfo,
  Comment,
  Id,
  Invite,
  Membership,
  Org,
  Principal,
  Project,
  Team,
  Ticket,
  User,
} from '@rooster/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import type { Repositories } from '../repositories.js'
import type { sqliteSchema } from '../schema/sqlite.js'

/**
 * The repository implementation is written once against the libSQL/SQLite
 * types and reused by the Postgres driver through a single type-bridge at the
 * driver boundary (see `drivers/postgres.ts`). This is sound because both
 * dialect schemas are structurally identical (text ids/timestamps, text JSON,
 * normalized booleans) and the Drizzle query API used here is dialect-agnostic.
 */
type Schema = typeof sqliteSchema
type DB = LibSQLDatabase<Record<string, never>>

const DEFAULT_LIMIT = 50

const now = () => new Date().toISOString()
const newId = (): Id => crypto.randomUUID()
const enc = (v: unknown): string => JSON.stringify(v)
const dec = <T>(v: string | null, fallback: T): T => (v == null ? fallback : (JSON.parse(v) as T))
const limitOf = (opts?: { limit?: number }) =>
  Math.min(Math.max(opts?.limit ?? DEFAULT_LIMIT, 1), 200)

// --- row → domain mappers ---------------------------------------------------

type Rows = { [K in keyof Schema]: Schema[K]['$inferSelect'] }

const toOrg = (r: Rows['orgs']): Org => r as Org
const toTeam = (r: Rows['teams']): Team => ({
  id: r.id,
  orgId: r.orgId,
  key: r.key,
  name: r.name,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
})
const toProject = (r: Rows['projects']): Project => r as Project
const toPrincipal = (r: Rows['principals']): Principal => r as Principal
const toUser = (r: Rows['users']): User => r as User
const toAgent = (r: Rows['agents']): Agent =>
  ({
    ...r,
    scopes: dec<string[]>(r.scopes, []),
  }) as Agent
const toMembership = (r: Rows['memberships']): Membership => r as Membership
const toInvite = (r: Rows['invites']): Invite => r as Invite
const toTicket = (r: Rows['tickets']): Ticket =>
  ({
    ...r,
    labels: dec<string[]>(r.labels, []),
  }) as Ticket
const toComment = (r: Rows['comments']): Comment => r as Comment
const toAudit = (r: Rows['auditLog']): AuditLog => ({
  ...r,
  before: dec<unknown>(r.before, null),
  after: dec<unknown>(r.after, null),
  clientInfo: dec<ClientInfo | null>(r.clientInfo, null),
})

export function createRepositories(db: DB, s: Schema): Repositories {
  const first = <T>(rows: T[]): T | null => rows[0] ?? null

  return {
    orgs: {
      async create(input) {
        const ts = now()
        const [row] = await db
          .insert(s.orgs)
          .values({ id: newId(), ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toOrg(row!)
      },
      async getById(id) {
        return first((await db.select().from(s.orgs).where(eq(s.orgs.id, id)).limit(1)).map(toOrg))
      },
      async getBySlug(slug) {
        return first(
          (await db.select().from(s.orgs).where(eq(s.orgs.slug, slug)).limit(1)).map(toOrg),
        )
      },
    },

    teams: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.teams)
          .values({ id: newId(), orgId, ...input, ticketSeq: 0, createdAt: ts, updatedAt: ts })
          .returning()
        return toTeam(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.teams)
              .where(and(eq(s.teams.orgId, orgId), eq(s.teams.id, id)))
              .limit(1)
          ).map(toTeam),
        )
      },
      async list(orgId, opts) {
        return (
          await db
            .select()
            .from(s.teams)
            .where(eq(s.teams.orgId, orgId))
            .orderBy(desc(s.teams.createdAt))
            .limit(limitOf(opts))
        ).map(toTeam)
      },
    },

    projects: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.projects)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toProject(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.projects)
              .where(and(eq(s.projects.orgId, orgId), eq(s.projects.id, id)))
              .limit(1)
          ).map(toProject),
        )
      },
      async list(orgId, teamId, opts) {
        const where = teamId
          ? and(eq(s.projects.orgId, orgId), eq(s.projects.teamId, teamId))
          : eq(s.projects.orgId, orgId)
        return (
          await db
            .select()
            .from(s.projects)
            .where(where)
            .orderBy(desc(s.projects.createdAt))
            .limit(limitOf(opts))
        ).map(toProject)
      },
    },

    tickets: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.tickets)
          .values({
            id: newId(),
            orgId,
            ...input,
            labels: enc(input.labels),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
        return toTicket(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.tickets)
              .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.id, id)))
              .limit(1)
          ).map(toTicket),
        )
      },
      async getByKey(orgId, key) {
        return first(
          (
            await db
              .select()
              .from(s.tickets)
              .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.key, key)))
              .limit(1)
          ).map(toTicket),
        )
      },
      async list(orgId, projectId, opts) {
        const filters = [eq(s.tickets.orgId, orgId), eq(s.tickets.projectId, projectId)]
        if (opts?.status) filters.push(eq(s.tickets.status, opts.status))
        if (opts?.assigneeId) filters.push(eq(s.tickets.assigneeId, opts.assigneeId))
        return (
          await db
            .select()
            .from(s.tickets)
            .where(and(...filters))
            .orderBy(desc(s.tickets.createdAt))
            .limit(limitOf(opts))
        ).map(toTicket)
      },
      async listAssigned(orgId, assigneeId, opts) {
        return (
          await db
            .select()
            .from(s.tickets)
            .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.assigneeId, assigneeId)))
            .orderBy(desc(s.tickets.createdAt))
            .limit(limitOf(opts))
        ).map(toTicket)
      },
      async listByLabel(orgId, label, opts) {
        // Prefilter with a LIKE against the JSON-encoded token (escaping LIKE
        // wildcards so it matches literally), then confirm with an exact
        // in-memory check — correct for any label, portable across dialects.
        const needle = enc(label).replace(/([\\%_])/g, '\\$1')
        const rows = (
          await db
            .select()
            .from(s.tickets)
            .where(
              and(
                eq(s.tickets.orgId, orgId),
                sql`${s.tickets.labels} LIKE ${`%${needle}%`} ESCAPE '\\'`,
              ),
            )
            .orderBy(desc(s.tickets.createdAt))
            .limit(limitOf(opts))
        ).map(toTicket)
        return rows.filter((t) => t.labels.includes(label))
      },
      async search(orgId, query, opts) {
        // Case-insensitive LIKE over title + description, escaping wildcards so
        // the query matches literally. lower() is portable across both dialects.
        const needle = query.replace(/([\\%_])/g, '\\$1').toLowerCase()
        const like = `%${needle}%`
        return (
          await db
            .select()
            .from(s.tickets)
            .where(
              and(
                eq(s.tickets.orgId, orgId),
                sql`(lower(${s.tickets.title}) LIKE ${like} ESCAPE '\\' OR lower(coalesce(${s.tickets.description}, '')) LIKE ${like} ESCAPE '\\')`,
              ),
            )
            .orderBy(desc(s.tickets.createdAt))
            .limit(limitOf(opts))
        ).map(toTicket)
      },
      async listChildren(orgId, parentId, opts) {
        return (
          await db
            .select()
            .from(s.tickets)
            .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.parentId, parentId)))
            .orderBy(desc(s.tickets.createdAt))
            .limit(limitOf(opts))
        ).map(toTicket)
      },
      async update(orgId, id, patch) {
        const set: Record<string, unknown> = { updatedAt: now() }
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'id' || k === 'orgId' || k === 'createdAt' || k === 'updatedAt') continue
          set[k] = k === 'labels' ? enc(v) : v
        }
        const [row] = await db
          .update(s.tickets)
          .set(set)
          .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.id, id)))
          .returning()
        if (!row) throw new Error(`Ticket ${id} not found in org ${orgId}`)
        return toTicket(row)
      },
      async nextNumber(orgId, teamId) {
        // Atomically allocate the next number from the team's sequence counter.
        return repoNextNumber(db, s, orgId, teamId)
      },
    },

    comments: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.comments)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toComment(row!)
      },
      async listForTicket(orgId, ticketId, opts) {
        return (
          await db
            .select()
            .from(s.comments)
            .where(and(eq(s.comments.orgId, orgId), eq(s.comments.ticketId, ticketId)))
            .orderBy(s.comments.createdAt)
            .limit(limitOf(opts))
        ).map(toComment)
      },
    },

    principals: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.principals)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toPrincipal(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.principals)
              .where(and(eq(s.principals.orgId, orgId), eq(s.principals.id, id)))
              .limit(1)
          ).map(toPrincipal),
        )
      },
      async findById(id) {
        return first(
          (await db.select().from(s.principals).where(eq(s.principals.id, id)).limit(1)).map(
            toPrincipal,
          ),
        )
      },
      async listByOrg(orgId, opts) {
        return (
          await db
            .select()
            .from(s.principals)
            .where(eq(s.principals.orgId, orgId))
            .orderBy(desc(s.principals.createdAt))
            .limit(limitOf(opts))
        ).map(toPrincipal)
      },
    },

    users: {
      async create(input) {
        const ts = now()
        const [row] = await db
          .insert(s.users)
          .values({
            id: newId(),
            authUserId: null,
            ...input,
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
        return toUser(row!)
      },
      async getById(id) {
        return first(
          (await db.select().from(s.users).where(eq(s.users.id, id)).limit(1)).map(toUser),
        )
      },
      async getByEmail(email) {
        return first(
          (await db.select().from(s.users).where(eq(s.users.email, email)).limit(1)).map(toUser),
        )
      },
      async getByPrincipalId(principalId) {
        return first(
          (
            await db.select().from(s.users).where(eq(s.users.principalId, principalId)).limit(1)
          ).map(toUser),
        )
      },
      async getByAuthUserId(authUserId) {
        return first(
          (await db.select().from(s.users).where(eq(s.users.authUserId, authUserId)).limit(1)).map(
            toUser,
          ),
        )
      },
      async linkAuthUserId(id, authUserId) {
        const [row] = await db
          .update(s.users)
          .set({ authUserId, updatedAt: now() })
          .where(eq(s.users.id, id))
          .returning()
        return toUser(row!)
      },
    },

    agents: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.agents)
          .values({
            id: newId(),
            orgId,
            ...input,
            scopes: enc(input.scopes),
            createdAt: ts,
            updatedAt: ts,
          })
          .returning()
        return toAgent(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.agents)
              .where(and(eq(s.agents.orgId, orgId), eq(s.agents.id, id)))
              .limit(1)
          ).map(toAgent),
        )
      },
      async getByOAuthClientId(clientId) {
        return first(
          (
            await db.select().from(s.agents).where(eq(s.agents.oauthClientId, clientId)).limit(1)
          ).map(toAgent),
        )
      },
      async list(orgId, opts) {
        return (
          await db
            .select()
            .from(s.agents)
            .where(eq(s.agents.orgId, orgId))
            .orderBy(desc(s.agents.createdAt))
            .limit(limitOf(opts))
        ).map(toAgent)
      },
      async update(orgId, id, patch) {
        const set: Record<string, unknown> = { updatedAt: now() }
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'id' || k === 'orgId' || k === 'createdAt' || k === 'updatedAt') continue
          set[k] = k === 'scopes' ? enc(v) : v
        }
        const [row] = await db
          .update(s.agents)
          .set(set)
          .where(and(eq(s.agents.orgId, orgId), eq(s.agents.id, id)))
          .returning()
        if (!row) throw new Error(`Agent ${id} not found in org ${orgId}`)
        return toAgent(row)
      },
    },

    memberships: {
      async list(orgId, principalId) {
        return (
          await db
            .select()
            .from(s.memberships)
            .where(and(eq(s.memberships.orgId, orgId), eq(s.memberships.principalId, principalId)))
        ).map(toMembership)
      },
      async listByOrg(orgId) {
        return (await db.select().from(s.memberships).where(eq(s.memberships.orgId, orgId))).map(
          toMembership,
        )
      },
      async upsert(orgId, input) {
        const teamPred =
          input.teamId == null
            ? isNull(s.memberships.teamId)
            : eq(s.memberships.teamId, input.teamId)
        const where = and(
          eq(s.memberships.orgId, orgId),
          eq(s.memberships.principalId, input.principalId),
          teamPred,
        )
        const [existing] = await db.select().from(s.memberships).where(where).limit(1)
        const ts = now()
        if (existing) {
          const [row] = await db
            .update(s.memberships)
            .set({ role: input.role, updatedAt: ts })
            .where(eq(s.memberships.id, existing.id))
            .returning()
          return toMembership(row!)
        }
        const [row] = await db
          .insert(s.memberships)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toMembership(row!)
      },
    },

    invites: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.invites)
          .values({ id: newId(), orgId, ...input, uses: 0, createdAt: ts, updatedAt: ts })
          .returning()
        return toInvite(row!)
      },
      async getByCode(code) {
        return first(
          (await db.select().from(s.invites).where(eq(s.invites.code, code)).limit(1)).map(
            toInvite,
          ),
        )
      },
      async incrementUses(orgId, id) {
        const [row] = await db
          .update(s.invites)
          .set({ uses: sql`${s.invites.uses} + 1`, updatedAt: now() })
          .where(and(eq(s.invites.orgId, orgId), eq(s.invites.id, id)))
          .returning()
        return toInvite(row!)
      },
    },

    rateLimits: {
      async hit(key, nowIso, windowFloorIso) {
        // Single atomic upsert: reset the window when the prior one elapsed,
        // otherwise increment. No transaction (libSQL :memory: drops tables in
        // a separate-connection transaction) — and shared across instances.
        const [row] = await db
          .insert(s.rateLimits)
          .values({ key, windowStart: nowIso, count: 1 })
          .onConflictDoUpdate({
            target: s.rateLimits.key,
            set: {
              count: sql`CASE WHEN ${s.rateLimits.windowStart} <= ${windowFloorIso} THEN 1 ELSE ${s.rateLimits.count} + 1 END`,
              windowStart: sql`CASE WHEN ${s.rateLimits.windowStart} <= ${windowFloorIso} THEN ${nowIso} ELSE ${s.rateLimits.windowStart} END`,
            },
          })
          .returning()
        return { count: row!.count, windowStart: row!.windowStart }
      },
    },

    audit: {
      async append(orgId, entry) {
        const [row] = await db
          .insert(s.auditLog)
          .values({
            id: newId(),
            orgId,
            principalId: entry.principalId,
            action: entry.action,
            targetType: entry.targetType,
            targetId: entry.targetId,
            before: entry.before == null ? null : enc(entry.before),
            after: entry.after == null ? null : enc(entry.after),
            clientInfo: entry.clientInfo == null ? null : enc(entry.clientInfo),
            createdAt: now(),
          })
          .returning()
        return toAudit(row!)
      },
      async list(orgId, opts) {
        return (
          await db
            .select()
            .from(s.auditLog)
            .where(eq(s.auditLog.orgId, orgId))
            .orderBy(desc(s.auditLog.createdAt))
            .limit(limitOf(opts))
        ).map(toAudit)
      },
    },
  }
}

/**
 * Allocate the next ticket number by atomically incrementing the team's
 * sequence counter in a single `UPDATE ... RETURNING` statement. Atomic on both
 * SQLite and Postgres without an explicit transaction, so it stays correct
 * under concurrency and avoids per-connection in-memory transaction quirks.
 */
async function repoNextNumber(db: DB, s: Schema, orgId: Id, teamId: Id): Promise<number> {
  const [row] = await db
    .update(s.teams)
    .set({ ticketSeq: sql`${s.teams.ticketSeq} + 1`, updatedAt: now() })
    .where(and(eq(s.teams.orgId, orgId), eq(s.teams.id, teamId)))
    .returning({ ticketSeq: s.teams.ticketSeq })
  if (!row) throw new Error(`Team ${teamId} not found in org ${orgId}`)
  return row.ticketSeq
}
