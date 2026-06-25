import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from './actor.js'
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import { provisionTenant } from './onboarding.js'
import { authorize, can } from './permissions.js'
import { createServices, type Services } from './services/index.js'
import { canTransition } from './transitions.js'

let db: Database
let services: Services

beforeEach(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
  db = await createDatabase(config, { migrate: true })
  services = createServices(db.repositories)
})

afterEach(async () => {
  await db.close()
})

async function bootstrap() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  return { org, founder, owner }
}

/** Create a human principal with the given role and resolve it to an Actor. */
async function makeUser(orgId: string, owner: Actor, role: Role): Promise<Actor> {
  const principal = await db.repositories.principals.create(orgId, {
    type: 'user',
    displayName: role,
  })
  await db.repositories.users.create({
    principalId: principal.id,
    email: `${role}-${principal.id}@acme.test`,
    name: role,
    avatarUrl: null,
  })
  await services.members.upsert(owner, { principalId: principal.id, teamId: null, role })
  return services.resolveActor({ orgId, principalId: principal.id })
}

async function makeProject(owner: Actor) {
  const team = await services.teams.create(owner, { key: 'ROOST', name: 'Roost' })
  const project = await services.projects.create(owner, { teamId: team.id, name: 'Henhouse' })
  return { team, project }
}

// --- pure units -------------------------------------------------------------

describe('permissions', () => {
  const userActor = (role: Role, scopes: string[] = []): Actor => ({
    orgId: 'o',
    principalId: 'p',
    type: 'user',
    role,
    scopes,
  })
  const agentActor = (role: Role, scopes: string[] = []): Actor => ({
    ...userActor(role, scopes),
    type: 'agent',
  })

  it('gates by role rank for humans', () => {
    expect(can(userActor('viewer'), 'ticket:read')).toBe(true)
    expect(can(userActor('viewer'), 'ticket:write')).toBe(false)
    expect(can(userActor('member'), 'ticket:write')).toBe(true)
    expect(can(userActor('member'), 'team:write')).toBe(false)
    expect(can(userActor('admin'), 'team:write')).toBe(true)
    expect(() => authorize(userActor('viewer'), 'ticket:write')).toThrow(ForbiddenError)
  })

  it('requires BOTH role and scope for agents', () => {
    // sufficient role, missing scope
    expect(can(agentActor('member'), 'ticket:write')).toBe(false)
    expect(can(agentActor('member', ['ticket:write']), 'ticket:write')).toBe(true)
    // wildcard scope
    expect(can(agentActor('member', ['*']), 'ticket:write')).toBe(true)
    // scope present but role too low
    expect(can(agentActor('viewer', ['ticket:write']), 'ticket:write')).toBe(false)
  })
})

describe('status transitions', () => {
  it('allows legal moves and rejects illegal ones', () => {
    expect(canTransition('backlog', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'done')).toBe(true)
    expect(canTransition('done', 'in_progress')).toBe(true)
    expect(canTransition('done', 'todo')).toBe(false)
    expect(canTransition('backlog', 'done')).toBe(false)
  })
})

// --- actor resolution -------------------------------------------------------

describe('resolveActor', () => {
  it('computes the highest membership role', async () => {
    const { owner } = await bootstrap()
    expect(owner.role).toBe('owner')
    expect(owner.type).toBe('user')
  })

  it('rejects a principal with no membership in the org', async () => {
    const { org } = await bootstrap()
    const stray = await db.repositories.principals.create(org.id, {
      type: 'user',
      displayName: 'stray',
    })
    await expect(
      services.resolveActor({ orgId: org.id, principalId: stray.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- ticket lifecycle -------------------------------------------------------

describe('ticket lifecycle', () => {
  it('creates a keyed ticket, transitions status and assigns', async () => {
    const { owner, founder } = await bootstrap()
    const { project } = await makeProject(owner)

    const ticket = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'Lay the foundation',
      priority: 'high',
      labels: ['infra'],
    })
    expect(ticket.key).toBe('ROOST-1')
    expect(ticket.status).toBe('backlog')

    const moved = await services.tickets.changeStatus(owner, {
      ticketId: ticket.id,
      status: 'in_progress',
    })
    expect(moved.status).toBe('in_progress')

    const assigned = await services.tickets.assign(owner, {
      ticketId: ticket.id,
      assigneeId: founder.id,
    })
    expect(assigned.assigneeId).toBe(founder.id)
  })

  it('rejects an illegal status transition', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'X' })

    await expect(
      services.tickets.changeStatus(owner, { ticketId: ticket.id, status: 'done' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects assigning a principal from another org', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'X' })

    const otherOrg = await services.orgs.bootstrap({
      org: { slug: 'other', name: 'Other', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bob', email: 'bob@other.test', name: 'Bob', avatarUrl: null },
    })
    await expect(
      services.tickets.assign(owner, { ticketId: ticket.id, assigneeId: otherOrg.founder.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// --- tags + subtask relationships -------------------------------------------

describe('tags and subtasks', () => {
  it('finds related tickets by tag', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    await services.tickets.create(owner, { projectId: project.id, title: 'a', labels: ['infra'] })
    await services.tickets.create(owner, {
      projectId: project.id,
      title: 'b',
      labels: ['infra', 'urgent'],
    })
    await services.tickets.create(owner, { projectId: project.id, title: 'c', labels: ['docs'] })

    const infra = await services.tickets.findByLabel(owner, 'infra')
    expect(infra.map((t) => t.title).sort()).toEqual(['a', 'b'])
  })

  it('lists subtasks and links a child to its parent', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const parent = await services.tickets.create(owner, { projectId: project.id, title: 'epic' })
    const child = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'subtask',
      parentId: parent.id,
    })
    expect(child.parentId).toBe(parent.id)

    const subtasks = await services.tickets.listSubtasks(owner, parent.id)
    expect(subtasks.map((t) => t.title)).toEqual(['subtask'])
  })

  it('rejects parent relationships that would form a cycle', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const a = await services.tickets.create(owner, { projectId: project.id, title: 'a' })
    const b = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'b',
      parentId: a.id,
    })

    // a -> b would close the loop a -> b -> a
    await expect(services.tickets.update(owner, a.id, { parentId: b.id })).rejects.toBeInstanceOf(
      ValidationError,
    )
    // a ticket cannot be its own parent
    await expect(services.tickets.update(owner, a.id, { parentId: a.id })).rejects.toBeInstanceOf(
      ValidationError,
    )
  })
})

// --- tenant onboarding ------------------------------------------------------

describe('provisionTenant', () => {
  it('bootstraps org + team + project + an owner agent bound to its client', async () => {
    const result = await provisionTenant(services, {
      org: { slug: 'rooster', name: 'Rooster' },
      founder: { name: 'Al', email: 'al@rooster.test' },
      team: { key: 'ROOST', name: 'Roost' },
      project: { name: 'Rooster Core' },
      agent: {
        displayName: 'Dev Claude',
        kind: 'claude-code',
        scopes: ['ticket:read', 'ticket:write'],
        oauthClientId: 'client-abc',
      },
    })

    expect(result.org.slug).toBe('rooster')
    expect(result.team.key).toBe('ROOST')
    expect(result.agent?.oauthClientId).toBe('client-abc')

    // The agent is a co-owner and can act immediately within its token scopes.
    const agentActor = await services.resolveActor({
      orgId: result.org.id,
      principalId: result.agent?.principalId ?? '',
      scopes: ['ticket:read', 'ticket:write'],
    })
    expect(agentActor.role).toBe('owner')
    const ticket = await services.tickets.create(agentActor, {
      projectId: result.project.id,
      title: 'First self-filed ticket',
      labels: ['bootstrap'],
    })
    expect(ticket.key).toBe('ROOST-1')
  })
})

// --- permission enforcement -------------------------------------------------

describe('permission enforcement', () => {
  it('lets members write tickets but blocks viewers and team creation', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const viewer = await makeUser(org.id, owner, 'viewer')
    const member = await makeUser(org.id, owner, 'member')

    await expect(
      services.tickets.create(viewer, { projectId: project.id, title: 'nope' }),
    ).rejects.toBeInstanceOf(ForbiddenError)

    const ok = await services.tickets.create(member, { projectId: project.id, title: 'yes' })
    expect(ok.key).toBe('ROOST-1')

    await expect(services.teams.create(member, { key: 'NEW', name: 'New' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })
})

// --- agents -----------------------------------------------------------------

describe('agents', () => {
  it('registers an agent that can act only within its token scopes', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)

    const agent = await services.agents.register(owner, {
      displayName: 'Backend Claude',
      kind: 'claude-code',
      scopes: ['ticket:read', 'ticket:write'],
    })
    expect(agent.status).toBe('active')

    const scoped = await services.resolveActor({
      orgId: org.id,
      principalId: agent.principalId,
      scopes: ['ticket:read', 'ticket:write'],
      clientInfo: { name: 'Claude Code', version: '1.0.0' },
    })
    const created = await services.tickets.create(scoped, {
      projectId: project.id,
      title: 'by-agent',
    })
    expect(created.key).toBe('ROOST-1')

    // Same agent identity but a token lacking ticket:write is denied.
    const readOnly = await services.resolveActor({
      orgId: org.id,
      principalId: agent.principalId,
      scopes: ['ticket:read'],
    })
    await expect(
      services.tickets.create(readOnly, { projectId: project.id, title: 'denied' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- audit ------------------------------------------------------------------

describe('audit logging', () => {
  it('attributes mutations to the trusted principal with a client snapshot', async () => {
    const { org, founder } = await bootstrap()
    const owner = await services.resolveActor({
      orgId: org.id,
      principalId: founder.id,
      clientInfo: { name: 'Claude Code', version: '9.9' },
    })
    const { project } = await makeProject(owner)
    await services.tickets.create(owner, { projectId: project.id, title: 'audited' })

    const log = await services.audit.list(owner)
    const actions = log.map((e) => e.action)
    expect(actions).toContain('ticket.create')
    expect(actions).toContain('team.create')
    expect(actions).toContain('org.bootstrap')

    const ticketCreate = log.find((e) => e.action === 'ticket.create')
    expect(ticketCreate?.principalId).toBe(founder.id)
    expect(ticketCreate?.clientInfo).toEqual({ name: 'Claude Code', version: '9.9' })
  })

  it('blocks non-admins from reading the audit log', async () => {
    const { org, owner } = await bootstrap()
    const member = await makeUser(org.id, owner, 'member')
    await expect(services.audit.list(member)).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- tenant isolation -------------------------------------------------------

describe('tenant isolation at the service layer', () => {
  it('scopes reads to the actor org', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'secret' })

    const other = await services.orgs.bootstrap({
      org: { slug: 'other', name: 'Other', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bob', email: 'bob@other.test', name: 'Bob', avatarUrl: null },
    })
    const otherOwner = await services.resolveActor({
      orgId: other.org.id,
      principalId: other.founder.id,
    })
    await expect(services.tickets.get(otherOwner, ticket.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
