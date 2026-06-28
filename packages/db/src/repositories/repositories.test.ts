import { loadConfig } from '@rooster/config'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabase, type Database } from '../database.js'
import { seed } from '../seed.js'

let db: Database

beforeEach(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
  db = await createDatabase(config, { migrate: true })
})

afterEach(async () => {
  await db.close()
})

async function makeOrgWithTeamProject(slug: string) {
  const repos = db.repositories
  const org = await repos.orgs.create({ slug, name: slug, enrollmentPolicy: 'token' })
  const team = await repos.teams.create(org.id, { key: 'ROOST', name: 'Roost' })
  const project = await repos.projects.create(org.id, {
    teamId: team.id,
    key: 'PRJ',
    name: 'P',
    description: null,
    archived: false,
  })
  return { org, team, project }
}

describe('migrations', () => {
  it('creates a queryable schema', async () => {
    expect(await db.repositories.orgs.getBySlug('nope')).toBeNull()
  })
})

describe('org / team / project round-trip', () => {
  it('persists and reads back through the driver', async () => {
    const { org, team, project } = await makeOrgWithTeamProject('acme')
    expect(await db.repositories.orgs.getById(org.id)).toMatchObject({ slug: 'acme' })
    expect(await db.repositories.orgs.getBySlug('acme')).toMatchObject({ id: org.id })
    expect(await db.repositories.teams.getById(org.id, team.id)).toMatchObject({ key: 'ROOST' })
    expect(await db.repositories.projects.getById(org.id, project.id)).toMatchObject({ name: 'P' })
    expect(await db.repositories.teams.list(org.id)).toHaveLength(1)
  })
})

describe('ticket numbering', () => {
  it('allocates sequential, gap-free numbers per project', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    const a = await db.repositories.tickets.nextNumber(org.id, project.id)
    const b = await db.repositories.tickets.nextNumber(org.id, project.id)
    const c = await db.repositories.tickets.nextNumber(org.id, project.id)
    expect([a, b, c]).toEqual([1, 2, 3])
  })

  it('self-heals a lagging counter so it never re-mints an existing number', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    // A ticket landed ahead of the counter (e.g. a manual re-key) — seq is still 0.
    await db.repositories.tickets.create(org.id, {
      projectId: project.id,
      key: 'PRJ-5',
      number: 5,
      title: 'out-of-band',
      description: null,
      status: 'todo',
      priority: 'none',
      labels: [],
      assigneeId: null,
      parentId: null,
    })
    // nextNumber must clear the existing max (5), not return the stale 1.
    expect(await db.repositories.tickets.nextNumber(org.id, project.id)).toBe(6)
  })
})

describe('embeddings (libSQL native vectors)', () => {
  // A 1536-dim vector (matching F32_BLOB(1536)) with a few non-zero components.
  const vec = (...nz: Array<[number, number]>) => {
    const v = new Array(1536).fill(0)
    for (const [i, x] of nz) v[i] = x
    return v
  }

  it('upserts and finds nearest, scoped to org + sourceType', async () => {
    const { org } = await makeOrgWithTeamProject('acme')
    const other = await makeOrgWithTeamProject('other')
    const e = db.repositories.embeddings

    await e.upsert(org.id, 'ticket', 't-near', vec([0, 1]), 'mock')
    await e.upsert(org.id, 'ticket', 't-far', vec([5, 1]), 'mock')
    await e.upsert(org.id, 'message', 't-near', vec([0, 1]), 'mock') // different sourceType
    await e.upsert(other.org.id, 'ticket', 't-foreign', vec([0, 1]), 'mock') // different org

    const hits = await e.search(org.id, 'ticket', vec([0, 1]), 10)
    expect(hits[0]?.sourceId).toBe('t-near')
    expect(hits[0]?.distance).toBeCloseTo(0, 5)
    const ids = hits.map((h) => h.sourceId)
    expect(ids).toContain('t-near')
    expect(ids).toContain('t-far')
    // org + sourceType isolation: never the other org or the message row.
    expect(ids).not.toContain('t-foreign')
  })

  it('upsert replaces (keyed by org+sourceType+sourceId) and existingFor/delete work', async () => {
    const { org } = await makeOrgWithTeamProject('acme')
    const e = db.repositories.embeddings
    await e.upsert(org.id, 'ticket', 't1', vec([0, 1]), 'mock')
    await e.upsert(org.id, 'ticket', 't1', vec([1, 1]), 'mock') // replace, not duplicate
    await e.upsert(org.id, 'ticket', 't2', vec([2, 1]), 'mock')

    expect((await e.existingFor(org.id, 'ticket', ['t1', 't2', 't3'])).sort()).toEqual(['t1', 't2'])
    // a single row for t1 (replaced, not duplicated)
    const hits = await e.search(org.id, 'ticket', vec([1, 1]), 10)
    expect(hits.filter((h) => h.sourceId === 't1')).toHaveLength(1)

    expect(await e.delete(org.id, 'ticket', 't1')).toBe(true)
    expect(await e.existingFor(org.id, 'ticket', ['t1', 't2'])).toEqual(['t2'])
  })

  it('honors ROOSTER_EMBEDDING_DIMS when sizing the runtime table', async () => {
    // The embeddings table is created at connect time from the configured dim,
    // not from a static migration — a small dim must round-trip end to end.
    const smallDb = await createDatabase(
      loadConfig({
        DATABASE_URL: 'file::memory:',
        ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
        ROOSTER_EMBEDDING_DIMS: '4',
      }),
      { migrate: true },
    )
    try {
      const repos = smallDb.repositories
      const org = await repos.orgs.create({ slug: 'dim', name: 'dim', enrollmentPolicy: 'token' })
      const e = repos.embeddings
      await e.upsert(org.id, 'ticket', 't-near', [1, 0, 0, 0], 'mock')
      await e.upsert(org.id, 'ticket', 't-far', [0, 0, 0, 1], 'mock')

      const hits = await e.search(org.id, 'ticket', [1, 0, 0, 0], 10)
      expect(hits[0]?.sourceId).toBe('t-near')
      expect(hits[0]?.distance).toBeCloseTo(0, 5)
    } finally {
      await smallDb.close()
    }
  })
})

describe('ticket JSON fields + updates', () => {
  it('round-trips labels and applies status/label updates', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    const created = await db.repositories.tickets.create(org.id, {
      projectId: project.id,
      key: 'ROOST-1',
      number: 1,
      title: 'First',
      description: null,
      status: 'todo',
      priority: 'high',
      labels: ['a', 'b'],
      assigneeId: null,
      parentId: null,
    })
    expect(created.labels).toEqual(['a', 'b'])

    const fetched = await db.repositories.tickets.getByKey(org.id, 'ROOST-1')
    expect(fetched?.labels).toEqual(['a', 'b'])

    const updated = await db.repositories.tickets.update(org.id, created.id, {
      status: 'done',
      labels: ['c'],
    })
    expect(updated.status).toBe('done')
    expect(updated.labels).toEqual(['c'])
    expect(updated.title).toBe('First')
  })
})

describe('agent scopes + audit JSON', () => {
  it('round-trips agent scopes and structured audit payloads', async () => {
    const { org } = await makeOrgWithTeamProject('acme')
    const principal = await db.repositories.principals.create(org.id, {
      type: 'agent',
      displayName: 'A',
    })
    const agent = await db.repositories.agents.create(org.id, {
      principalId: principal.id,
      ownerUserId: principal.id,
      displayName: 'A',
      kind: 'claude-code',
      vendor: null,
      version: null,
      oauthClientId: 'client-123',
      scopes: ['ticket:write', 'ticket:read'],
      status: 'active',
    })
    expect(agent.scopes).toEqual(['ticket:write', 'ticket:read'])
    expect(await db.repositories.agents.getByOAuthClientId('client-123')).toMatchObject({
      id: agent.id,
    })

    const entry = await db.repositories.audit.append(org.id, {
      principalId: principal.id,
      action: 'change_status',
      targetType: 'ticket',
      targetId: null,
      before: { status: 'todo' },
      after: { status: 'done' },
      clientInfo: { name: 'Claude Code', version: '1.2.3' },
    })
    expect(entry.after).toEqual({ status: 'done' })
    expect(entry.clientInfo).toEqual({ name: 'Claude Code', version: '1.2.3' })

    const log = await db.repositories.audit.list(org.id)
    expect(log).toHaveLength(1)
    expect(log[0]?.action).toBe('change_status')
  })
})

describe('membership upsert', () => {
  it('inserts then updates the same (org, principal, team) row', async () => {
    const { org } = await makeOrgWithTeamProject('acme')
    const p = await db.repositories.principals.create(org.id, { type: 'user', displayName: 'U' })
    const first = await db.repositories.memberships.upsert(org.id, {
      principalId: p.id,
      teamId: null,
      role: 'member',
    })
    const second = await db.repositories.memberships.upsert(org.id, {
      principalId: p.id,
      teamId: null,
      role: 'admin',
    })
    expect(second.id).toBe(first.id)
    expect(second.role).toBe('admin')
    expect(await db.repositories.memberships.list(org.id, p.id)).toHaveLength(1)
  })
})

describe('tenant isolation', () => {
  it('does not leak rows across orgs', async () => {
    const a = await makeOrgWithTeamProject('org-a')
    const b = await makeOrgWithTeamProject('org-b')
    const ticket = await db.repositories.tickets.create(a.org.id, {
      projectId: a.project.id,
      key: 'ROOST-1',
      number: 1,
      title: 'A-only',
      description: null,
      status: 'todo',
      priority: 'none',
      labels: [],
      assigneeId: null,
      parentId: null,
    })

    // Reads scoped to org B must not see org A's rows.
    expect(await db.repositories.tickets.getById(b.org.id, ticket.id)).toBeNull()
    expect(await db.repositories.tickets.getByKey(b.org.id, 'ROOST-1')).toBeNull()
    expect(await db.repositories.teams.getById(b.org.id, a.team.id)).toBeNull()
    expect(await db.repositories.tickets.list(b.org.id, a.project.id)).toHaveLength(0)

    // ...but org A still sees its own.
    expect(await db.repositories.tickets.getById(a.org.id, ticket.id)).toMatchObject({
      title: 'A-only',
    })
  })
})

describe('tags + subtask relationships', () => {
  async function mkTicket(
    orgId: string,
    projectId: string,
    over: Partial<{ key: string; number: number; labels: string[]; parentId: string | null }>,
  ) {
    return db.repositories.tickets.create(orgId, {
      projectId,
      key: over.key ?? 'ROOST-1',
      number: over.number ?? 1,
      title: 'T',
      description: null,
      status: 'todo',
      priority: 'none',
      labels: over.labels ?? [],
      assigneeId: null,
      parentId: over.parentId ?? null,
    })
  }

  it('finds tickets by exact tag, ignoring substring near-misses', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    await mkTicket(org.id, project.id, { key: 'ROOST-1', number: 1, labels: ['infra', 'urgent'] })
    await mkTicket(org.id, project.id, { key: 'ROOST-2', number: 2, labels: ['infrastructure'] })
    await mkTicket(org.id, project.id, { key: 'ROOST-3', number: 3, labels: ['urgent'] })

    const infra = await db.repositories.tickets.listByLabel(org.id, 'infra')
    expect(infra.map((t) => t.key)).toEqual(['ROOST-1'])
    const urgent = await db.repositories.tickets.listByLabel(org.id, 'urgent')
    expect(urgent.map((t) => t.key).sort()).toEqual(['ROOST-1', 'ROOST-3'])
  })

  it('handles tags containing quotes/wildcards correctly', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    await mkTicket(org.id, project.id, { key: 'ROOST-1', number: 1, labels: ['a"b', '50%'] })
    expect(await db.repositories.tickets.listByLabel(org.id, 'a"b')).toHaveLength(1)
    expect(await db.repositories.tickets.listByLabel(org.id, '50%')).toHaveLength(1)
    expect(await db.repositories.tickets.listByLabel(org.id, '5')).toHaveLength(0)
  })

  it('ranks search by term coverage, title weight and phrase match', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    const mk = (key: string, number: number, title: string, description: string | null) =>
      db.repositories.tickets.create(org.id, {
        projectId: project.id,
        key,
        number,
        title,
        description,
        status: 'todo',
        priority: 'none',
        labels: [],
        assigneeId: null,
        parentId: null,
      })
    await mk('PRJ-1', 1, 'Wire the MCP server', 'connect the transport')
    await mk('PRJ-2', 2, 'MCP transport bug', null)
    await mk('PRJ-3', 3, 'Unrelated chore', 'mentions a server once')

    const hits = await db.repositories.tickets.search(org.id, 'MCP server')
    // PRJ-1: both terms in title + full phrase; PRJ-2: one title term; PRJ-3: one body term.
    expect(hits.map((t) => t.key)).toEqual(['PRJ-1', 'PRJ-2', 'PRJ-3'])

    // A term that appears nowhere yields no results.
    expect(await db.repositories.tickets.search(org.id, 'kubernetes')).toEqual([])
  })

  it('stems terms and stays in sync on edits (FTS upgrade over LIKE)', async () => {
    const { org, project } = await makeOrgWithTeamProject('stem')
    const t = await db.repositories.tickets.create(org.id, {
      projectId: project.id,
      key: 'STM-1',
      number: 1,
      title: 'Deploying the worker',
      description: 'runs migrations',
      status: 'todo',
      priority: 'none',
      labels: [],
      assigneeId: null,
      parentId: null,
    })

    // Stemming: "deploy" matches "Deploying", "migration" matches "migrations" —
    // neither would match a naive substring LIKE.
    expect((await db.repositories.tickets.search(org.id, 'deploy')).map((x) => x.key)).toEqual([
      'STM-1',
    ])
    expect((await db.repositories.tickets.search(org.id, 'migration')).map((x) => x.key)).toEqual([
      'STM-1',
    ])

    // The sync triggers keep the index current when a ticket is edited.
    await db.repositories.tickets.update(org.id, t.id, {
      title: 'Archived task',
      description: null,
    })
    expect(await db.repositories.tickets.search(org.id, 'deploy')).toEqual([])
    expect((await db.repositories.tickets.search(org.id, 'archived')).map((x) => x.key)).toEqual([
      'STM-1',
    ])
  })

  it('scopes search results to the org', async () => {
    const a = await makeOrgWithTeamProject('search-a')
    const b = await makeOrgWithTeamProject('search-b')
    const mk = (orgId: string, projectId: string, key: string) =>
      db.repositories.tickets.create(orgId, {
        projectId,
        key,
        number: 1,
        title: 'shared keyword widget',
        description: null,
        status: 'todo',
        priority: 'none',
        labels: [],
        assigneeId: null,
        parentId: null,
      })
    await mk(a.org.id, a.project.id, 'AAA-1')
    await mk(b.org.id, b.project.id, 'BBB-1')

    expect((await db.repositories.tickets.search(a.org.id, 'widget')).map((x) => x.key)).toEqual([
      'AAA-1',
    ])
  })

  it('lists direct subtasks of a parent', async () => {
    const { org, project } = await makeOrgWithTeamProject('acme')
    const parent = await mkTicket(org.id, project.id, { key: 'ROOST-1', number: 1 })
    await mkTicket(org.id, project.id, { key: 'ROOST-2', number: 2, parentId: parent.id })
    await mkTicket(org.id, project.id, { key: 'ROOST-3', number: 3, parentId: parent.id })
    await mkTicket(org.id, project.id, { key: 'ROOST-4', number: 4 })

    const children = await db.repositories.tickets.listChildren(org.id, parent.id)
    expect(children.map((t) => t.key).sort()).toEqual(['ROOST-2', 'ROOST-3'])
  })
})

describe('seed', () => {
  it('produces a coherent demo dataset and is idempotent', async () => {
    const first = await seed(db.repositories)
    expect(first.ticketKeys).toEqual(['HEN-1', 'HEN-2'])
    expect(await db.repositories.orgs.getBySlug('acme')).not.toBeNull()

    const agents = await db.repositories.agents.list(first.orgId)
    expect(agents[0]?.kind).toBe('claude-code')
    expect(agents[0]?.scopes).toContain('ticket:write')

    const again = await seed(db.repositories)
    expect(again.orgId).toBe(first.orgId)
    expect(await db.repositories.agents.list(first.orgId)).toHaveLength(1)
  })
})
