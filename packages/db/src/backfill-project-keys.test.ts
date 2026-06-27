import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backfillProjectKeys } from './backfill-project-keys.js'
import { createRepositories } from './repositories/impl.js'
import { sqliteSchema } from './schema/sqlite.js'

const MIGRATIONS = fileURLToPath(new URL('../migrations/sqlite', import.meta.url))

// Build a libSQL in-memory handle exposing BOTH the raw drizzle db (for the
// backfill) and the repositories (for arranging data) on one connection.
let client: ReturnType<typeof createClient>
// biome-ignore lint/suspicious/noExplicitAny: test-local handle, schema is fixed
let db: any
let repos: ReturnType<typeof createRepositories>

beforeEach(async () => {
  client = createClient({ url: ':memory:' })
  db = drizzle(client)
  await migrate(db, { migrationsFolder: MIGRATIONS })
  repos = createRepositories(db, sqliteSchema)
})

afterEach(() => {
  client.close()
})

/** Reproduce the pre-migration shape: two keyless projects under one team whose
 *  tickets were numbered from a single global sequence. */
async function legacyOrg() {
  const org = await repos.orgs.create({ slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' })
  const team = await repos.teams.create(org.id, { key: 'ROOST', name: 'Roost' })
  // Projects created WITHOUT a key (the column is nullable for legacy rows).
  const rooster = await repos.projects.create(org.id, {
    teamId: team.id,
    name: 'Rooster',
    description: null,
    archived: false,
  } as never)
  const aston = await repos.projects.create(org.id, {
    teamId: team.id,
    name: 'astonagent',
    description: null,
    archived: false,
  } as never)
  // Tickets numbered globally: ROOST-1/2 in Rooster, ROOST-3 in astonagent.
  const mk = (projectId: string, key: string, number: number) =>
    repos.tickets.create(org.id, {
      projectId,
      key,
      number,
      title: key,
      description: null,
      status: 'backlog',
      priority: 'none',
      labels: [],
      assigneeId: null,
      parentId: null,
    } as never)
  await mk(rooster.id, 'ROOST-1', 1)
  await mk(rooster.id, 'ROOST-2', 2)
  await mk(aston.id, 'ROOST-3', 3)
  return { org, rooster, aston }
}

describe('backfillProjectKeys', () => {
  it('keeps the old prefix continuing and starts a fresh key at 1, collision-safe', async () => {
    const { org, rooster, aston } = await legacyOrg()

    const result = await backfillProjectKeys(db, sqliteSchema, {
      keyMap: { Rooster: 'ROOST', astonagent: 'ASA' },
    })
    expect(result.updated).toHaveLength(2)

    const rooked = await repos.projects.getById(org.id, rooster.id)
    const astoned = await repos.projects.getById(org.id, aston.id)
    expect(rooked?.key).toBe('ROOST')
    expect(astoned?.key).toBe('ASA')

    // Rooster keeps ROOST and must skip past the org's highest ROOST-N (3, held
    // by astonagent), so its next ticket is ROOST-4 — never re-minting ROOST-3.
    expect(await repos.tickets.nextNumber(org.id, rooster.id)).toBe(4)
    // astonagent's fresh ASA key has no existing ASA-N, so it starts at ASA-1.
    expect(await repos.tickets.nextNumber(org.id, aston.id)).toBe(1)
  })

  it('is idempotent — already-keyed projects are skipped on a second run', async () => {
    const { org, rooster } = await legacyOrg()
    await backfillProjectKeys(db, sqliteSchema, { keyMap: { Rooster: 'ROOST', astonagent: 'ASA' } })

    const second = await backfillProjectKeys(db, sqliteSchema, {})
    expect(second.updated).toHaveLength(0)
    expect(second.skipped.map((s) => s.name).sort()).toEqual(['Rooster', 'astonagent'])
    // A subsequent run did not disturb the established key.
    expect((await repos.projects.getById(org.id, rooster.id))?.key).toBe('ROOST')
  })

  it('auto-derives unique keys when none are supplied', async () => {
    const { org, rooster, aston } = await legacyOrg()
    const result = await backfillProjectKeys(db, sqliteSchema, {})
    const keys = result.updated.map((u) => u.key)
    expect(new Set(keys).size).toBe(keys.length) // all unique
    for (const k of keys) expect(k).toMatch(/^[A-Z][A-Z0-9]{2,4}$/)
    expect((await repos.projects.getById(org.id, rooster.id))?.key).toBeTruthy()
    expect((await repos.projects.getById(org.id, aston.id))?.key).toBeTruthy()
  })

  it('rejects a requested key that collides or is malformed', async () => {
    await legacyOrg()
    await expect(
      backfillProjectKeys(db, sqliteSchema, { keyMap: { Rooster: 'AB', astonagent: 'ASA' } }),
    ).rejects.toThrow() // 'AB' is too short
  })
})
