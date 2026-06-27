import { createClient } from '@libsql/client'
import { loadConfig } from '@rooster/config'
import { projectKeySchema } from '@rooster/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { drizzle as drizzleLibsql, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { pgSchema } from './schema/pg.js'
import { sqliteSchema } from './schema/sqlite.js'

/**
 * One-time data backfill for migration 0007 (ticket prefix moved from team to
 * project). For every project with a NULL `key` it picks a unique-per-org key
 * and advances `ticket_seq` so newly minted ticket keys never collide with the
 * project's existing tickets.
 *
 * Why a bespoke script (not a SQL migration): the right key for each project is
 * a judgement call (e.g. "astonagent" → ASA), and the safe `ticket_seq` value
 * depends on the live ticket data — neither is expressible as static migration
 * SQL. Run it once, after `db:migrate`, on an upgraded database:
 *
 *   # auto-derive keys from team key / project name:
 *   DATABASE_URL=… pnpm --filter @rooster/db db:backfill-project-keys
 *
 *   # or pin specific keys (by project name OR id), preview first:
 *   ROOSTER_PROJECT_KEYS='{"Rooster":"ROOST","astonagent":"ASA"}' DRY_RUN=1 \
 *     DATABASE_URL=… pnpm --filter @rooster/db db:backfill-project-keys
 *
 * Idempotent: projects that already have a key are left untouched.
 */

// The repo layer proves one libSQL-typed query builder drives both dialects
// (the two schemas are structurally identical), so the backfill is written once
// against that type and the Postgres handle/schema are bridged in via `as`.
type Db = LibSQLDatabase<Record<string, never>>
type Schema = typeof sqliteSchema

export interface BackfillPlanRow {
  orgId: string
  projectId: string
  name: string
  key: string
  ticketSeq: number
}

export interface BackfillResult {
  updated: BackfillPlanRow[]
  skipped: { projectId: string; name: string; key: string }[]
}

/** Uppercase A–Z/0–9, forced to start with a letter — the projectKey alphabet. */
function sanitize(base: string): string {
  const alnum = base.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]/.test(alnum) ? alnum : `P${alnum}`
}

/**
 * Pick an unused 3–5 char key for a project: take 3 chars of the sanitized base,
 * widening to 4 then 5 on collision, then falling back to a numeric suffix.
 */
function deriveKey(base: string, taken: Set<string>): string {
  const root = `${sanitize(base)}XXX`.slice(0, 5) // pad so slice(0,3) is always ≥3
  for (let len = 3; len <= 5; len++) {
    const candidate = root.slice(0, len)
    if (!taken.has(candidate)) return candidate
  }
  const stem = root.slice(0, 3)
  for (let n = 2; n < 100; n++) {
    const candidate = `${stem.slice(0, 4)}${n}`.slice(0, 5)
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`Could not derive a free project key from '${base}'`)
}

export async function backfillProjectKeys(
  db: Db,
  s: Schema,
  opts: { keyMap?: Record<string, string>; dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const keyMap = opts.keyMap ?? {}
  const now = new Date().toISOString()

  const allProjects = await db.select().from(s.projects)
  const teams = await db.select().from(s.teams)
  const teamById = new Map(teams.map((t) => [t.id, t]))

  const result: BackfillResult = { updated: [], skipped: [] }
  const orgIds = [...new Set(allProjects.map((p) => p.orgId))]

  for (const orgId of orgIds) {
    const projects = allProjects.filter((p) => p.orgId === orgId)
    const taken = new Set(projects.map((p) => p.key).filter((k): k is string => !!k))
    const tickets = await db
      .select({ key: s.tickets.key, number: s.tickets.number, projectId: s.tickets.projectId })
      .from(s.tickets)
      .where(eq(s.tickets.orgId, orgId))

    for (const project of projects) {
      if (project.key) {
        result.skipped.push({ projectId: project.id, name: project.name, key: project.key })
        continue
      }

      const requested = keyMap[project.id] ?? keyMap[project.name]
      let key: string
      if (requested) {
        key = requested.toUpperCase()
        const parsed = projectKeySchema.safeParse(key)
        if (!parsed.success) {
          throw new Error(
            `Requested key '${requested}' for '${project.name}' is not a valid 3–5 char project key`,
          )
        }
        if (taken.has(key)) {
          throw new Error(
            `Requested key '${key}' for '${project.name}' is already used in this org`,
          )
        }
      } else {
        key = deriveKey(teamById.get(project.teamId)?.key ?? project.name, taken)
      }
      taken.add(key)

      // Collision-safe sequence: advance past the highest existing ticket number
      // that already shares this key's prefix — anywhere in the org, since the
      // unique key is (org, ticket key). Keeping a project's old prefix continues
      // its numbering; assigning a fresh key restarts at 1 (existing tickets keep
      // their old keys, so there's nothing to collide with).
      const prefix = `${key}-`
      const ticketSeq = tickets.reduce(
        (max, t) => (t.key.startsWith(prefix) && t.number > max ? t.number : max),
        0,
      )

      if (!opts.dryRun) {
        await db
          .update(s.projects)
          .set({ key, ticketSeq, updatedAt: now })
          .where(
            and(eq(s.projects.orgId, orgId), eq(s.projects.id, project.id), isNull(s.projects.key)),
          )
      }
      result.updated.push({ orgId, projectId: project.id, name: project.name, key, ticketSeq })
    }
  }

  return result
}

/** Open a raw drizzle handle for the dialect implied by DATABASE_URL. */
async function connect(config: ReturnType<typeof loadConfig>) {
  if (config.database.kind === 'postgres') {
    const pool = new pg.Pool({ connectionString: config.database.url })
    return {
      db: drizzlePg(pool) as unknown as Db,
      s: pgSchema as unknown as Schema,
      close: () => pool.end(),
    }
  }
  const url = config.database.url === 'file::memory:' ? ':memory:' : config.database.url
  const client = createClient({ url, authToken: config.database.authToken })
  return {
    db: drizzleLibsql(client) as unknown as Db,
    s: sqliteSchema,
    close: async () => client.close(),
  }
}

// CLI entry: `pnpm --filter @rooster/db db:backfill-project-keys` (after build).
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
  let keyMap: Record<string, string> | undefined
  if (process.env.ROOSTER_PROJECT_KEYS) {
    keyMap = JSON.parse(process.env.ROOSTER_PROJECT_KEYS)
  }

  const { db, s, close } = await connect(config)
  try {
    const result = await backfillProjectKeys(db, s, { keyMap, dryRun })
    const tag = dryRun ? '(dry run — nothing written)' : ''
    console.log(`Project-key backfill ${tag}`)
    for (const u of result.updated) {
      console.log(`  + ${u.name}: key=${u.key}, ticket_seq=${u.ticketSeq}`)
    }
    for (const sk of result.skipped) {
      console.log(`  · ${sk.name}: already keyed (${sk.key}) — skipped`)
    }
    console.log(`Done: ${result.updated.length} updated, ${result.skipped.length} skipped.`)
  } finally {
    await close()
  }
}
