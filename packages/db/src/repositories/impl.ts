import type {
  Agent,
  Attachment,
  AuditLog,
  ClientInfo,
  Comment,
  ContextFile,
  ConversationMessage,
  Id,
  Invite,
  Membership,
  Milestone,
  Org,
  Principal,
  Project,
  Team,
  Ticket,
  TicketAssignee,
  TicketLink,
  User,
  Watcher,
} from '@rooster/schema'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
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

/** Build a ticket UPDATE `set` from a patch: bump updatedAt, JSON-encode labels,
 * and never let the patch overwrite identity/timestamp columns. */
const ticketUpdateSet = (patch: Record<string, unknown>): Record<string, unknown> => {
  const set: Record<string, unknown> = { updatedAt: now() }
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || k === 'orgId' || k === 'createdAt' || k === 'updatedAt') continue
    set[k] = k === 'labels' ? enc(v) : v
  }
  return set
}

/** Which SQL dialect the repositories run against — selects the FTS engine. */
export type Dialect = 'sqlite' | 'pg'

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
const toConversationMessage = (r: Rows['conversationMessages']): ConversationMessage =>
  ({
    ...r,
    metadata: dec<unknown>(r.metadata, null),
  }) as ConversationMessage
const toTicketLink = (r: Rows['ticketLinks']): TicketLink => r as TicketLink
const toWatcher = (r: Rows['ticketWatchers']): Watcher => r as Watcher
const toMilestone = (r: Rows['milestones']): Milestone => r as Milestone
const toTicketAssignee = (r: Rows['ticketAssignees']): TicketAssignee => r as TicketAssignee
const toAttachment = (r: Rows['attachments']): Attachment => r as Attachment
const toContextFile = (r: Rows['contextFiles']): ContextFile => r as ContextFile
const toAudit = (r: Rows['auditLog']): AuditLog => ({
  ...r,
  before: dec<unknown>(r.before, null),
  after: dec<unknown>(r.after, null),
  clientInfo: dec<ClientInfo | null>(r.clientInfo, null),
})

export function createRepositories(db: DB, s: Schema, dialect: Dialect = 'sqlite'): Repositories {
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
          .values({ id: newId(), orgId, ...input, ticketSeq: 0, createdAt: ts, updatedAt: ts })
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
      async update(orgId, id, patch) {
        const set: Record<string, unknown> = { updatedAt: now() }
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'id' || k === 'orgId' || k === 'createdAt' || k === 'updatedAt') continue
          set[k] = v
        }
        const [row] = await db
          .update(s.projects)
          .set(set)
          .where(and(eq(s.projects.orgId, orgId), eq(s.projects.id, id)))
          .returning()
        if (!row) throw new Error(`Project ${id} not found in org ${orgId}`)
        return toProject(row)
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
        if (opts?.milestoneId) filters.push(eq(s.tickets.milestoneId, opts.milestoneId))
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
        // Primary assignee OR a co-assignee via the join table.
        return (
          await db
            .select()
            .from(s.tickets)
            .where(
              and(
                eq(s.tickets.orgId, orgId),
                or(
                  eq(s.tickets.assigneeId, assigneeId),
                  sql`${s.tickets.id} IN (SELECT ${s.ticketAssignees.ticketId} FROM ${s.ticketAssignees} WHERE ${s.ticketAssignees.orgId} = ${orgId} AND ${s.ticketAssignees.principalId} = ${assigneeId})`,
                ),
              ),
            )
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
        // Full-text search over title + description, one signature with a
        // dialect-specific engine: Postgres tsvector/GIN ranked by ts_rank
        // (title weighted above body), SQLite/libSQL FTS5 ranked by bm25 (title
        // weighted 10x body). Both stem (so "running" matches "run"); terms are
        // sanitized to alphanumerics and OR-combined for recall (any term may
        // match). This is the one place the two dialects legitimately diverge.
        const terms = query
          .toLowerCase()
          .split(/\s+/)
          .map((t) => t.replace(/[^a-z0-9]/g, ''))
          .filter(Boolean)
          .slice(0, 12)
        if (terms.length === 0) return []
        const limit = limitOf(opts)

        if (dialect === 'pg') {
          const tsquery = terms.join(' | ')
          const doc = sql`to_tsvector('english', coalesce(${s.tickets.title}, '') || ' ' || coalesce(${s.tickets.description}, ''))`
          // Ranking weights the title (A) above the description (B).
          const rank = sql`ts_rank(setweight(to_tsvector('english', coalesce(${s.tickets.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${s.tickets.description}, '')), 'B'), to_tsquery('english', ${tsquery}))`
          return (
            await db
              .select()
              .from(s.tickets)
              .where(
                and(eq(s.tickets.orgId, orgId), sql`${doc} @@ to_tsquery('english', ${tsquery})`),
              )
              .orderBy(sql`${rank} DESC`)
              .limit(limit)
          ).map(toTicket)
        }

        // SQLite / libSQL: match in the FTS5 index (joined to tickets by rowid),
        // rank with bm25, then load the matched tickets preserving rank order.
        const matchQuery = terms.join(' OR ')
        const idRows = await db.all<{ id: string }>(sql`
          SELECT t.id AS id FROM tickets_fts
          JOIN ${s.tickets} t ON t.rowid = tickets_fts.rowid
          WHERE t.org_id = ${orgId} AND tickets_fts MATCH ${matchQuery}
          ORDER BY bm25(tickets_fts, 10.0, 1.0)
          LIMIT ${limit}
        `)
        const ids = idRows.map((r) => r.id)
        if (ids.length === 0) return []
        const byId = new Map(
          (
            await db
              .select()
              .from(s.tickets)
              .where(and(eq(s.tickets.orgId, orgId), inArray(s.tickets.id, ids)))
          ).map((r) => [r.id, toTicket(r)] as const),
        )
        return ids.map((id) => byId.get(id)).filter((t): t is Ticket => t != null)
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
        const [row] = await db
          .update(s.tickets)
          .set(ticketUpdateSet(patch))
          .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.id, id)))
          .returning()
        if (!row) throw new Error(`Ticket ${id} not found in org ${orgId}`)
        return toTicket(row)
      },
      async updateIfMatches(orgId, id, patch, expectedUpdatedAt) {
        // Conditional on the unchanged updatedAt — atomic optimistic concurrency.
        // No matching row ⇒ the guard failed (concurrent write) or the ticket is
        // gone; either way the caller treats null as a conflict.
        const [row] = await db
          .update(s.tickets)
          .set(ticketUpdateSet(patch))
          .where(
            and(
              eq(s.tickets.orgId, orgId),
              eq(s.tickets.id, id),
              eq(s.tickets.updatedAt, expectedUpdatedAt),
            ),
          )
          .returning()
        return row ? toTicket(row) : null
      },
      async claimNext(orgId, projectId, principalId, claimableStatuses) {
        if (claimableStatuses.length === 0) return null
        const statuses = sql.join(
          claimableStatuses.map((st) => sql`${st}`),
          sql`, `,
        )
        // Pick the best candidate and claim it in ONE atomic statement (mirrors
        // the nextNumber pattern): highest priority, then oldest, among
        // unassigned + actionable + unblocked tickets. A `blocks` link counts as
        // blocking only while its blocker is unresolved (not done/canceled). The
        // outer `assignee_id IS NULL` guard makes a lost race a no-op (returns
        // null) so two callers never claim the same ticket; under serialized
        // writes the in-statement subselect re-evaluates, so the loser simply
        // picks the next candidate. Raw column names (snake_case) are identical
        // across both dialects; `CASE` keeps the priority ranking dialect-neutral.
        const candidate = sql`(
          SELECT cand.id FROM ${s.tickets} cand
          WHERE cand.org_id = ${orgId}
            AND cand.project_id = ${projectId}
            AND cand.assignee_id IS NULL
            AND cand.status IN (${statuses})
            AND NOT EXISTS (
              SELECT 1 FROM ${s.ticketLinks} bl
              JOIN ${s.tickets} blk ON blk.id = bl.from_ticket_id AND blk.org_id = cand.org_id
              WHERE bl.org_id = cand.org_id
                AND bl.type = 'blocks'
                AND bl.to_ticket_id = cand.id
                AND blk.status NOT IN ('done', 'canceled')
            )
          ORDER BY
            CASE cand.priority
              WHEN 'urgent' THEN 5
              WHEN 'high' THEN 4
              WHEN 'medium' THEN 3
              WHEN 'low' THEN 2
              ELSE 1
            END DESC,
            cand.created_at ASC
          LIMIT 1
        )`
        const [row] = await db
          .update(s.tickets)
          .set({ assigneeId: principalId, updatedAt: now() })
          .where(
            and(
              eq(s.tickets.orgId, orgId),
              isNull(s.tickets.assigneeId),
              sql`${s.tickets.id} = ${candidate}`,
            ),
          )
          .returning()
        return row ? toTicket(row) : null
      },
      async reKeyForProject(orgId, projectId, oldPrefix, newPrefix) {
        // Rewrite "<old>-<n>" → "<new>-<n>" keeping the numeric suffix. `substr`
        // + `||` are dialect-neutral; the cut point is the old prefix length + 2
        // (1-based, past the "-"). Scoped to this project's tickets only.
        const cut = oldPrefix.length + 2
        const rows = await db
          .update(s.tickets)
          .set({
            key: sql`${newPrefix} || '-' || substr(${s.tickets.key}, ${cut})`,
            updatedAt: now(),
          })
          .where(and(eq(s.tickets.orgId, orgId), eq(s.tickets.projectId, projectId)))
          .returning({ id: s.tickets.id })
        return rows.length
      },
      async nextNumber(orgId, projectId) {
        // Atomically allocate the next number from the project's sequence counter.
        return repoNextNumber(db, s, orgId, projectId)
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

    conversation: {
      async appendMany(orgId, ticketId, stage, messages) {
        if (messages.length === 0) return []
        const ts = now()
        // Allocate seq after the current max for this (ticket, stage). One read +
        // one multi-row insert (no transaction — respects the in-memory caveat);
        // all rows in a batch share createdAt, so (createdAt, seq) orders them.
        const [maxRow] = await db
          .select({ max: sql<number>`COALESCE(MAX(${s.conversationMessages.seq}), 0)` })
          .from(s.conversationMessages)
          .where(
            and(
              eq(s.conversationMessages.orgId, orgId),
              eq(s.conversationMessages.ticketId, ticketId),
              eq(s.conversationMessages.stage, stage),
            ),
          )
        const base = Number(maxRow?.max ?? 0)
        const rows = messages.map((m, i) => ({
          id: newId(),
          orgId,
          ticketId,
          stage,
          authorId: m.authorId,
          role: m.role,
          kind: m.kind,
          seq: base + 1 + i,
          body: m.body,
          metadata: m.metadata == null ? null : enc(m.metadata),
          createdAt: ts,
          updatedAt: ts,
        }))
        return (await db.insert(s.conversationMessages).values(rows).returning()).map(
          toConversationMessage,
        )
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.conversationMessages)
              .where(
                and(eq(s.conversationMessages.orgId, orgId), eq(s.conversationMessages.id, id)),
              )
              .limit(1)
          ).map(toConversationMessage),
        )
      },
      async listForTicket(orgId, ticketId, opts) {
        const filters = [
          eq(s.conversationMessages.orgId, orgId),
          eq(s.conversationMessages.ticketId, ticketId),
        ]
        if (opts?.stage) filters.push(eq(s.conversationMessages.stage, opts.stage))
        return (
          await db
            .select()
            .from(s.conversationMessages)
            .where(and(...filters))
            .orderBy(s.conversationMessages.createdAt, s.conversationMessages.seq)
            .limit(limitOf(opts))
        ).map(toConversationMessage)
      },
      async delete(orgId, id) {
        const rows = await db
          .delete(s.conversationMessages)
          .where(and(eq(s.conversationMessages.orgId, orgId), eq(s.conversationMessages.id, id)))
          .returning({ id: s.conversationMessages.id })
        return rows.length > 0
      },
      async deleteForTicket(orgId, ticketId) {
        const rows = await db
          .delete(s.conversationMessages)
          .where(
            and(
              eq(s.conversationMessages.orgId, orgId),
              eq(s.conversationMessages.ticketId, ticketId),
            ),
          )
          .returning({ id: s.conversationMessages.id })
        return rows.length
      },
    },

    embeddings: {
      async upsert(orgId, sourceType, sourceId, vector, model) {
        const ts = now()
        const vec = `[${vector.join(',')}]`
        // Insert-or-replace keyed by the unique (org, source_type, source_id).
        // The vector is written through libSQL's native `vector32()`.
        await db.run(sql`
          INSERT INTO embeddings (id, org_id, source_type, source_id, model, embedding, created_at, updated_at)
          VALUES (${newId()}, ${orgId}, ${sourceType}, ${sourceId}, ${model}, vector32(${vec}), ${ts}, ${ts})
          ON CONFLICT(org_id, source_type, source_id) DO UPDATE SET
            embedding = vector32(${vec}), model = ${model}, updated_at = ${ts}
        `)
      },
      async search(orgId, sourceType, queryVector, candidateK) {
        const vec = `[${queryVector.join(',')}]`
        // ANN top-k is global (no metadata pre-filter), so over-fetch then filter
        // to the org + type. k is a server-controlled integer → inline as a
        // literal (vector_top_k's k arg doesn't take a bound param).
        const k = Math.max(1, Math.floor(candidateK))
        const rows = (await db.all(sql`
          SELECT e.source_id AS sourceId,
                 vector_distance_cos(e.embedding, vector32(${vec})) AS distance
          FROM vector_top_k('embeddings_vec_idx', vector32(${vec}), ${sql.raw(String(k))}) AS v
          JOIN embeddings e ON e.rowid = v.id
          WHERE e.org_id = ${orgId} AND e.source_type = ${sourceType}
          ORDER BY distance ASC
        `)) as Array<{ sourceId: string; distance: number }>
        return rows.map((r) => ({ sourceId: r.sourceId, distance: Number(r.distance) }))
      },
      async existingFor(orgId, sourceType, sourceIds) {
        if (sourceIds.length === 0) return []
        // The `embeddings` table is runtime-created (not a Drizzle table), so it
        // can't be referenced through `s.*` — query it as raw SQL.
        const ids = sql.join(
          sourceIds.map((sid) => sql`${sid}`),
          sql`, `,
        )
        const rows = (await db.all(sql`
          SELECT source_id AS sourceId FROM embeddings
          WHERE org_id = ${orgId} AND source_type = ${sourceType}
            AND source_id IN (${ids})
        `)) as Array<{ sourceId: string }>
        return rows.map((r) => r.sourceId)
      },
      async searchAny(orgId, queryVector, candidateK) {
        const vec = `[${queryVector.join(',')}]`
        const k = Math.max(1, Math.floor(candidateK))
        const rows = (await db.all(sql`
          SELECT e.source_id AS sourceId, e.source_type AS sourceType,
                 vector_distance_cos(e.embedding, vector32(${vec})) AS distance
          FROM vector_top_k('embeddings_vec_idx', vector32(${vec}), ${sql.raw(String(k))}) AS v
          JOIN embeddings e ON e.rowid = v.id
          WHERE e.org_id = ${orgId}
          ORDER BY distance ASC
        `)) as Array<{ sourceId: string; sourceType: string; distance: number }>
        return rows.map((r) => ({
          sourceId: r.sourceId,
          sourceType: r.sourceType,
          distance: Number(r.distance),
        }))
      },
      async delete(orgId, sourceType, sourceId) {
        const rows = (await db.all(sql`
          DELETE FROM embeddings
          WHERE org_id = ${orgId} AND source_type = ${sourceType} AND source_id = ${sourceId}
          RETURNING id
        `)) as Array<{ id: string }>
        return rows.length > 0
      },
    },

    contextFiles: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.contextFiles)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toContextFile(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.contextFiles)
              .where(and(eq(s.contextFiles.orgId, orgId), eq(s.contextFiles.id, id)))
              .limit(1)
          ).map(toContextFile),
        )
      },
      async list(orgId, projectId, opts) {
        const filters = [eq(s.contextFiles.orgId, orgId), eq(s.contextFiles.projectId, projectId)]
        if (opts?.ticketId) filters.push(eq(s.contextFiles.ticketId, opts.ticketId))
        return (
          await db
            .select()
            .from(s.contextFiles)
            .where(and(...filters))
            .orderBy(desc(s.contextFiles.updatedAt))
            .limit(limitOf(opts))
        ).map(toContextFile)
      },
      async update(orgId, id, patch) {
        const set: Record<string, unknown> = { updatedAt: now() }
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'id' || k === 'orgId' || k === 'createdAt' || k === 'updatedAt') continue
          set[k] = v
        }
        const [row] = await db
          .update(s.contextFiles)
          .set(set)
          .where(and(eq(s.contextFiles.orgId, orgId), eq(s.contextFiles.id, id)))
          .returning()
        if (!row) throw new Error(`Context file ${id} not found in org ${orgId}`)
        return toContextFile(row)
      },
      async delete(orgId, id) {
        const rows = await db
          .delete(s.contextFiles)
          .where(and(eq(s.contextFiles.orgId, orgId), eq(s.contextFiles.id, id)))
          .returning({ id: s.contextFiles.id })
        return rows.length > 0
      },
    },

    attachments: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.attachments)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toAttachment(row!)
      },
      async listForTicket(orgId, ticketId, opts) {
        return (
          await db
            .select()
            .from(s.attachments)
            .where(and(eq(s.attachments.orgId, orgId), eq(s.attachments.ticketId, ticketId)))
            .orderBy(s.attachments.createdAt)
            .limit(limitOf(opts))
        ).map(toAttachment)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.attachments)
              .where(and(eq(s.attachments.orgId, orgId), eq(s.attachments.id, id)))
              .limit(1)
          ).map(toAttachment),
        )
      },
      async delete(orgId, id) {
        const rows = await db
          .delete(s.attachments)
          .where(and(eq(s.attachments.orgId, orgId), eq(s.attachments.id, id)))
          .returning({ id: s.attachments.id })
        return rows.length > 0
      },
    },

    ticketLinks: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.ticketLinks)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toTicketLink(row!)
      },
      async listForTicket(orgId, ticketId) {
        return (
          await db
            .select()
            .from(s.ticketLinks)
            .where(
              and(
                eq(s.ticketLinks.orgId, orgId),
                or(
                  eq(s.ticketLinks.fromTicketId, ticketId),
                  eq(s.ticketLinks.toTicketId, ticketId),
                ),
              ),
            )
            .orderBy(s.ticketLinks.createdAt)
        ).map(toTicketLink)
      },
      async find(orgId, fromTicketId, toTicketId, type) {
        return first(
          (
            await db
              .select()
              .from(s.ticketLinks)
              .where(
                and(
                  eq(s.ticketLinks.orgId, orgId),
                  eq(s.ticketLinks.fromTicketId, fromTicketId),
                  eq(s.ticketLinks.toTicketId, toTicketId),
                  eq(s.ticketLinks.type, type),
                ),
              )
              .limit(1)
          ).map(toTicketLink),
        )
      },
      async delete(orgId, fromTicketId, toTicketId, type) {
        const rows = await db
          .delete(s.ticketLinks)
          .where(
            and(
              eq(s.ticketLinks.orgId, orgId),
              eq(s.ticketLinks.fromTicketId, fromTicketId),
              eq(s.ticketLinks.toTicketId, toTicketId),
              eq(s.ticketLinks.type, type),
            ),
          )
          .returning({ id: s.ticketLinks.id })
        return rows.length > 0
      },
    },

    watchers: {
      async add(orgId, ticketId, principalId) {
        const existing = first(
          (
            await db
              .select()
              .from(s.ticketWatchers)
              .where(
                and(
                  eq(s.ticketWatchers.orgId, orgId),
                  eq(s.ticketWatchers.ticketId, ticketId),
                  eq(s.ticketWatchers.principalId, principalId),
                ),
              )
              .limit(1)
          ).map(toWatcher),
        )
        if (existing) return existing
        const ts = now()
        const [row] = await db
          .insert(s.ticketWatchers)
          .values({ id: newId(), orgId, ticketId, principalId, createdAt: ts, updatedAt: ts })
          .returning()
        return toWatcher(row!)
      },
      async remove(orgId, ticketId, principalId) {
        const rows = await db
          .delete(s.ticketWatchers)
          .where(
            and(
              eq(s.ticketWatchers.orgId, orgId),
              eq(s.ticketWatchers.ticketId, ticketId),
              eq(s.ticketWatchers.principalId, principalId),
            ),
          )
          .returning({ id: s.ticketWatchers.id })
        return rows.length > 0
      },
      async listForTicket(orgId, ticketId) {
        return (
          await db
            .select()
            .from(s.ticketWatchers)
            .where(and(eq(s.ticketWatchers.orgId, orgId), eq(s.ticketWatchers.ticketId, ticketId)))
            .orderBy(s.ticketWatchers.createdAt)
        ).map(toWatcher)
      },
      async listWatchedTicketIds(orgId, principalId, opts) {
        return (
          await db
            .select({ ticketId: s.ticketWatchers.ticketId })
            .from(s.ticketWatchers)
            .where(
              and(eq(s.ticketWatchers.orgId, orgId), eq(s.ticketWatchers.principalId, principalId)),
            )
            .orderBy(desc(s.ticketWatchers.createdAt))
            .limit(limitOf(opts))
        ).map((r) => r.ticketId)
      },
    },

    assignees: {
      async add(orgId, ticketId, principalId) {
        const existing = first(
          (
            await db
              .select()
              .from(s.ticketAssignees)
              .where(
                and(
                  eq(s.ticketAssignees.orgId, orgId),
                  eq(s.ticketAssignees.ticketId, ticketId),
                  eq(s.ticketAssignees.principalId, principalId),
                ),
              )
              .limit(1)
          ).map(toTicketAssignee),
        )
        if (existing) return existing
        const ts = now()
        const [row] = await db
          .insert(s.ticketAssignees)
          .values({ id: newId(), orgId, ticketId, principalId, createdAt: ts, updatedAt: ts })
          .returning()
        return toTicketAssignee(row!)
      },
      async remove(orgId, ticketId, principalId) {
        const rows = await db
          .delete(s.ticketAssignees)
          .where(
            and(
              eq(s.ticketAssignees.orgId, orgId),
              eq(s.ticketAssignees.ticketId, ticketId),
              eq(s.ticketAssignees.principalId, principalId),
            ),
          )
          .returning({ id: s.ticketAssignees.id })
        return rows.length > 0
      },
      async listForTicket(orgId, ticketId) {
        return (
          await db
            .select()
            .from(s.ticketAssignees)
            .where(
              and(eq(s.ticketAssignees.orgId, orgId), eq(s.ticketAssignees.ticketId, ticketId)),
            )
            .orderBy(s.ticketAssignees.createdAt)
        ).map(toTicketAssignee)
      },
    },

    milestones: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.milestones)
          .values({ id: newId(), orgId, ...input, createdAt: ts, updatedAt: ts })
          .returning()
        return toMilestone(row!)
      },
      async getById(orgId, id) {
        return first(
          (
            await db
              .select()
              .from(s.milestones)
              .where(and(eq(s.milestones.orgId, orgId), eq(s.milestones.id, id)))
              .limit(1)
          ).map(toMilestone),
        )
      },
      async listForProject(orgId, projectId, opts) {
        return (
          await db
            .select()
            .from(s.milestones)
            .where(and(eq(s.milestones.orgId, orgId), eq(s.milestones.projectId, projectId)))
            .orderBy(desc(s.milestones.createdAt))
            .limit(limitOf(opts))
        ).map(toMilestone)
      },
    },

    principals: {
      async create(orgId, input) {
        const ts = now()
        const [row] = await db
          .insert(s.principals)
          .values({
            id: newId(),
            orgId,
            ...input,
            userId: input.userId ?? null,
            createdAt: ts,
            updatedAt: ts,
          })
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
      async getWithMemberships(orgId, id) {
        // One round-trip: principal LEFT JOIN its memberships in this org. The
        // principal repeats per membership row (null membership when it has
        // none — which the actor resolver treats as "no membership").
        const rows = await db
          .select({ principal: s.principals, membership: s.memberships })
          .from(s.principals)
          .leftJoin(
            s.memberships,
            and(
              eq(s.memberships.orgId, s.principals.orgId),
              eq(s.memberships.principalId, s.principals.id),
            ),
          )
          .where(and(eq(s.principals.orgId, orgId), eq(s.principals.id, id)))
        if (rows.length === 0) return null
        const principal = toPrincipal(rows[0]!.principal)
        const memberships = rows
          .map((r) => r.membership)
          .filter((m): m is NonNullable<typeof m> => m != null)
          .map(toMembership)
        return { principal, memberships }
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
      async listByUserId(userId) {
        return (
          await db
            .select()
            .from(s.principals)
            .where(eq(s.principals.userId, userId))
            .orderBy(desc(s.principals.createdAt))
        ).map(toPrincipal)
      },
      async linkUser(orgId, id, userId) {
        const [row] = await db
          .update(s.principals)
          .set({ userId, updatedAt: now() })
          .where(and(eq(s.principals.orgId, orgId), eq(s.principals.id, id)))
          .returning()
        return toPrincipal(row!)
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

    idempotency: {
      async lookup(orgId, key) {
        return first(
          (
            await db
              .select({ ticketId: s.idempotencyKeys.ticketId })
              .from(s.idempotencyKeys)
              .where(and(eq(s.idempotencyKeys.orgId, orgId), eq(s.idempotencyKeys.key, key)))
              .limit(1)
          ).map((r) => ({ ticketId: r.ticketId })),
        )
      },
      async record(orgId, key, ticketId) {
        // Claim the key with a single insert; onConflictDoNothing makes a
        // duplicate (already-recorded) key a no-op. A returned row means we won.
        const rows = await db
          .insert(s.idempotencyKeys)
          .values({ id: newId(), orgId, key, ticketId, createdAt: now() })
          .onConflictDoNothing({ target: [s.idempotencyKeys.orgId, s.idempotencyKeys.key] })
          .returning({ id: s.idempotencyKeys.id })
        return rows.length > 0
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
 * Allocate the next ticket number by atomically advancing the project's
 * sequence counter in a single `UPDATE ... RETURNING` statement. Atomic on both
 * SQLite and Postgres without an explicit transaction, so it stays correct
 * under concurrency and avoids per-connection in-memory transaction quirks.
 *
 * Self-healing: the counter advances past the highest number among tickets that
 * already share this project's **current key prefix**, as well as its own value.
 * So a `ticket_seq` that has drifted behind reality (manual re-key, out-of-band
 * insert, a backfill that skipped the project) can never re-mint an existing
 * `<key>-<n>` and trip the unique constraint. The prefix filter matters: a
 * project re-keyed to a fresh prefix restarts at 1 even if it holds tickets
 * under an old prefix. `CASE WHEN` (not SQLite `MAX(a,b)` / Postgres `GREATEST`)
 * keeps it dialect-neutral.
 */
async function repoNextNumber(db: DB, s: Schema, orgId: Id, projectId: Id): Promise<number> {
  const maxExisting = sql`COALESCE((SELECT MAX(${s.tickets.number}) FROM ${s.tickets} WHERE ${s.tickets.orgId} = ${orgId} AND ${s.tickets.projectId} = ${projectId} AND ${s.tickets.key} LIKE ${s.projects.key} || '-%'), 0)`
  const [row] = await db
    .update(s.projects)
    .set({
      ticketSeq: sql`(CASE WHEN ${s.projects.ticketSeq} >= ${maxExisting} THEN ${s.projects.ticketSeq} ELSE ${maxExisting} END) + 1`,
      updatedAt: now(),
    })
    .where(and(eq(s.projects.orgId, orgId), eq(s.projects.id, projectId)))
    .returning({ ticketSeq: s.projects.ticketSeq })
  if (!row) throw new Error(`Project ${projectId} not found in org ${orgId}`)
  return row.ticketSeq
}
