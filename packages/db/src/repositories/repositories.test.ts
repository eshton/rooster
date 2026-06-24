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
  it('allocates sequential, gap-free numbers per team', async () => {
    const { org, team } = await makeOrgWithTeamProject('acme')
    const a = await db.repositories.tickets.nextNumber(org.id, team.id)
    const b = await db.repositories.tickets.nextNumber(org.id, team.id)
    const c = await db.repositories.tickets.nextNumber(org.id, team.id)
    expect([a, b, c]).toEqual([1, 2, 3])
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

describe('seed', () => {
  it('produces a coherent demo dataset and is idempotent', async () => {
    const first = await seed(db.repositories)
    expect(first.ticketKeys).toEqual(['ROOST-1', 'ROOST-2'])
    expect(await db.repositories.orgs.getBySlug('acme')).not.toBeNull()

    const agents = await db.repositories.agents.list(first.orgId)
    expect(agents[0]?.kind).toBe('claude-code')
    expect(agents[0]?.scopes).toContain('ticket:write')

    const again = await seed(db.repositories)
    expect(again.orgId).toBe(first.orgId)
    expect(await db.repositories.agents.list(first.orgId)).toHaveLength(1)
  })
})
