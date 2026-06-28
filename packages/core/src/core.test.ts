import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Actor } from './actor.js'
import { InMemoryActorCache } from './cache.js'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.js'
import type { CrowEvent, NotificationEvent } from './notify.js'
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
  const project = await services.projects.create(owner, {
    teamId: team.id,
    key: 'ROOST',
    name: 'Henhouse',
  })
  return { team, project }
}

/** A separate org with one ticket — for cross-tenant isolation checks. */
async function bootstrap2() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'other', name: 'Other', enrollmentPolicy: 'open' },
    founder: { displayName: 'Bo', email: 'bo@other.test', name: 'Bo', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  const team = await services.teams.create(owner, { name: 'T' })
  const project = await services.projects.create(owner, { teamId: team.id, key: 'OTH', name: 'P' })
  const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'foreign' })
  return { orgId: org.id, ticketId: ticket.id }
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

describe('InMemoryActorCache', () => {
  const actor = (principalId: string): Actor => ({
    orgId: 'o',
    principalId,
    type: 'agent',
    role: 'member',
    scopes: ['ticket:write'],
  })

  it('caches and returns an actor; misses unknown keys', async () => {
    const cache = new InMemoryActorCache()
    expect(await cache.get('k')).toBeUndefined()
    await cache.set('k', actor('p1'), 1000)
    expect((await cache.get('k'))?.principalId).toBe('p1')
  })

  it('expires entries once the TTL elapses', async () => {
    vi.useFakeTimers()
    try {
      const cache = new InMemoryActorCache()
      await cache.set('k', actor('p1'), 1000)
      vi.advanceTimersByTime(1001)
      expect(await cache.get('k')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a non-positive TTL as a no-op', async () => {
    const cache = new InMemoryActorCache()
    await cache.set('k', actor('p1'), 0)
    expect(await cache.get('k')).toBeUndefined()
  })

  it('evicts least-recently-used entries beyond the max size', async () => {
    const cache = new InMemoryActorCache(2)
    await cache.set('a', actor('a'), 1000)
    await cache.set('b', actor('b'), 1000)
    // Touch 'a' so 'b' becomes the least-recently-used, then overflow.
    await cache.get('a')
    await cache.set('c', actor('c'), 1000)
    expect(await cache.get('b')).toBeUndefined()
    expect((await cache.get('a'))?.principalId).toBe('a')
    expect((await cache.get('c'))?.principalId).toBe('c')
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
      project: { name: 'Rooster Core', key: 'ROOST' },
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

// --- project keys ------------------------------------------------------------

describe('project keys', () => {
  it('keys tickets by project, numbers each project independently', async () => {
    const { owner } = await bootstrap()
    const team = await services.teams.create(owner, { name: 'Eng' })
    const asa = await services.projects.create(owner, {
      teamId: team.id,
      key: 'ASA',
      name: 'Aston',
    })
    const web = await services.projects.create(owner, { teamId: team.id, key: 'WEB', name: 'Web' })

    const a1 = await services.tickets.create(owner, { projectId: asa.id, title: 'a' })
    const w1 = await services.tickets.create(owner, { projectId: web.id, title: 'w' })
    const a2 = await services.tickets.create(owner, { projectId: asa.id, title: 'a2' })

    expect([a1.key, a2.key]).toEqual(['ASA-1', 'ASA-2'])
    expect(w1.key).toBe('WEB-1') // independent per-project sequence
  })

  it('rejects a duplicate project key in the same org (collision → widen the key)', async () => {
    const { owner } = await bootstrap()
    const team = await services.teams.create(owner, { name: 'Eng' })
    await services.projects.create(owner, { teamId: team.id, key: 'ASA', name: 'Aston' })

    await expect(
      services.projects.create(owner, { teamId: team.id, key: 'ASA', name: 'Aston 2' }),
    ).rejects.toBeInstanceOf(ConflictError)

    // Widening to a 4-char key resolves the collision.
    const ok = await services.projects.create(owner, { teamId: team.id, key: 'ASA2', name: 'A2' })
    expect(ok.key).toBe('ASA2')
  })

  it('allows creating a team without a key', async () => {
    const { owner } = await bootstrap()
    const team = await services.teams.create(owner, { name: 'Keyless' })
    expect(team.key).toBeNull()
  })
})

// --- ticket links ------------------------------------------------------------

describe('ticket links', () => {
  async function threeTickets() {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const mk = (title: string) => services.tickets.create(owner, { projectId: project.id, title })
    const a = await mk('A')
    const b = await mk('B')
    const c = await mk('C')
    return { owner, a, b, c }
  }

  it('links tickets and resolves inverse relations from each perspective', async () => {
    const { owner, a, b } = await threeTickets()
    await services.tickets.link(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'blocks' })

    const fromA = await services.tickets.listLinks(owner, a.id)
    expect(fromA).toEqual([{ relation: 'blocks', ticketId: b.id, key: b.key, title: 'B' }])

    const fromB = await services.tickets.listLinks(owner, b.id)
    expect(fromB).toEqual([{ relation: 'blocked_by', ticketId: a.id, key: a.key, title: 'A' }])
  })

  it('rejects self-links and duplicates (including the relates mirror)', async () => {
    const { owner, a, b } = await threeTickets()
    await expect(
      services.tickets.link(owner, { fromTicketId: a.id, toTicketId: a.id, type: 'relates' }),
    ).rejects.toBeInstanceOf(ValidationError)

    await services.tickets.link(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'relates' })
    // exact duplicate
    await expect(
      services.tickets.link(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'relates' }),
    ).rejects.toBeInstanceOf(ConflictError)
    // mirror of a symmetric relation is also a duplicate
    await expect(
      services.tickets.link(owner, { fromTicketId: b.id, toTicketId: a.id, type: 'relates' }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  it('prevents cycles in the blocks graph', async () => {
    const { owner, a, b, c } = await threeTickets()
    await services.tickets.link(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'blocks' })
    await services.tickets.link(owner, { fromTicketId: b.id, toTicketId: c.id, type: 'blocks' })
    // c blocks a would close the loop a→b→c→a
    await expect(
      services.tickets.link(owner, { fromTicketId: c.id, toTicketId: a.id, type: 'blocks' }),
    ).rejects.toBeInstanceOf(ValidationError)
    // a non-blocks relation between the same pair is still allowed
    const ok = await services.tickets.link(owner, {
      fromTicketId: c.id,
      toTicketId: a.id,
      type: 'relates',
    })
    expect(ok.relation).toBe('relates')
  })

  it('unlinks, and rejects removing a link that does not exist', async () => {
    const { owner, a, b } = await threeTickets()
    await services.tickets.link(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'duplicates' })
    expect(
      await services.tickets.unlink(owner, {
        fromTicketId: a.id,
        toTicketId: b.id,
        type: 'duplicates',
      }),
    ).toEqual({ removed: true })
    expect(await services.tickets.listLinks(owner, a.id)).toEqual([])
    await expect(
      services.tickets.unlink(owner, { fromTicketId: a.id, toTicketId: b.id, type: 'duplicates' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('rejects linking a ticket from another org (404)', async () => {
    const { owner, a } = await threeTickets()
    const other = await bootstrap2()
    await expect(
      services.tickets.link(owner, {
        fromTicketId: a.id,
        toTicketId: other.ticketId,
        type: 'relates',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// --- attachments -------------------------------------------------------------

describe('attachments', () => {
  it('adds, lists and removes attachments on a ticket', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'T' })

    const added = await services.attachments.add(owner, {
      ticketId: ticket.id,
      url: 'https://example.com/build.log',
      label: 'CI log',
    })
    expect(added.url).toBe('https://example.com/build.log')
    expect(added.label).toBe('CI log')
    expect(added.addedById).toBe(owner.principalId)

    const list = await services.attachments.list(owner, ticket.id)
    expect(list.map((a) => a.id)).toEqual([added.id])

    expect(await services.attachments.remove(owner, { attachmentId: added.id })).toEqual({
      removed: true,
    })
    expect(await services.attachments.list(owner, ticket.id)).toEqual([])
  })

  it('rejects a non-URL, a missing ticket, and removing a missing attachment', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'T' })

    await expect(
      services.attachments.add(owner, { ticketId: ticket.id, url: 'not-a-url' }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(
      services.attachments.add(owner, {
        ticketId: '00000000-0000-4000-8000-000000000000',
        url: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      services.attachments.remove(owner, {
        attachmentId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('blocks a viewer from attaching (ticket:write required)', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const ticket = await services.tickets.create(owner, { projectId: project.id, title: 'T' })
    const viewer = await makeUser(org.id, owner, 'viewer')

    await expect(
      services.attachments.add(viewer, { ticketId: ticket.id, url: 'https://example.com' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- re-key + move -----------------------------------------------------------

describe('set_project_key and move_ticket', () => {
  it('renames a project prefix and re-keys its tickets in lockstep', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner) // key ROOST
    const t1 = await services.tickets.create(owner, { projectId: project.id, title: 'a' })
    const t2 = await services.tickets.create(owner, { projectId: project.id, title: 'b' })
    expect([t1.key, t2.key]).toEqual(['ROOST-1', 'ROOST-2'])

    const updated = await services.projects.setKey(owner, { projectId: project.id, key: 'NEW' })
    expect(updated.key).toBe('NEW')
    expect((await services.tickets.get(owner, t1.id)).key).toBe('NEW-1')
    expect((await services.tickets.get(owner, t2.id)).key).toBe('NEW-2')

    // The sequence continues under the new prefix (self-healing nextNumber).
    const t3 = await services.tickets.create(owner, { projectId: project.id, title: 'c' })
    expect(t3.key).toBe('NEW-3')
  })

  it('rejects a duplicate or unchanged project key', async () => {
    const { owner } = await bootstrap()
    const team = await services.teams.create(owner, { name: 'Eng' })
    const a = await services.projects.create(owner, { teamId: team.id, key: 'AAA', name: 'A' })
    await services.projects.create(owner, { teamId: team.id, key: 'BBB', name: 'B' })

    await expect(
      services.projects.setKey(owner, { projectId: a.id, key: 'BBB' }),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      services.projects.setKey(owner, { projectId: a.id, key: 'AAA' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('moves a ticket to another project with a fresh key + number', async () => {
    const { owner } = await bootstrap()
    const team = await services.teams.create(owner, { name: 'Eng' })
    const src = await services.projects.create(owner, { teamId: team.id, key: 'SRC', name: 'S' })
    const dst = await services.projects.create(owner, { teamId: team.id, key: 'DST', name: 'D' })
    const t = await services.tickets.create(owner, { projectId: src.id, title: 'x' })
    expect(t.key).toBe('SRC-1')

    const moved = await services.tickets.move(owner, { ticketId: t.id, toProjectId: dst.id })
    expect(moved.projectId).toBe(dst.id)
    expect(moved.key).toBe('DST-1')
    expect((await services.tickets.list(owner, dst.id)).map((x) => x.id)).toContain(t.id)
    expect((await services.tickets.list(owner, src.id)).map((x) => x.id)).not.toContain(t.id)

    // Moving to the same project is a no-op error.
    await expect(
      services.tickets.move(owner, { ticketId: t.id, toProjectId: dst.id }),
    ).rejects.toBeInstanceOf(ValidationError)
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

// --- service guards (negative paths) ----------------------------------------

const MISSING_ID = '00000000-0000-4000-8000-000000000000'

describe('service guards', () => {
  it('refuses agent registration by a non-human principal', async () => {
    const { org, owner } = await bootstrap()
    // An agent with admin role + agent:write scope clears authorize(), so the
    // request reaches the "humans only" guard rather than the role/scope floor.
    const agent = await services.agents.register(owner, {
      displayName: 'Registrar Bot',
      kind: 'claude-code',
      scopes: ['agent:read', 'agent:write'],
    })
    await services.members.upsert(owner, {
      principalId: agent.principalId,
      teamId: null,
      role: 'admin',
    })
    const agentActor = await services.resolveActor({
      orgId: org.id,
      principalId: agent.principalId,
      scopes: ['agent:read', 'agent:write'],
    })
    await expect(
      services.agents.register(agentActor, {
        displayName: 'Sub Bot',
        kind: 'claude-code',
        scopes: ['ticket:read'],
      }),
    ).rejects.toThrow(/human/i)
  })

  it('404s get/setStatus for a missing agent', async () => {
    const { owner } = await bootstrap()
    await expect(services.agents.get(owner, MISSING_ID)).rejects.toBeInstanceOf(NotFoundError)
    await expect(services.agents.setStatus(owner, MISSING_ID, 'suspended')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('rejects a duplicate team key and 404s a missing team', async () => {
    const { owner } = await bootstrap()
    await services.teams.create(owner, { key: 'DUP', name: 'First' })
    await expect(
      services.teams.create(owner, { key: 'DUP', name: 'Second' }),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(services.teams.get(owner, MISSING_ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('404s commenting on or listing comments for a missing ticket', async () => {
    const { owner } = await bootstrap()
    await expect(
      services.comments.create(owner, { ticketId: MISSING_ID, body: 'hi' }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(services.comments.list(owner, MISSING_ID)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('re-inviting an existing org member updates their role (idempotent)', async () => {
    const { org, owner } = await bootstrap()
    const created = await services.members.invite(owner, { email: 'kit@acme.test', role: 'viewer' })
    expect(created.status).toBe('created')

    const updated = await services.members.invite(owner, { email: 'kit@acme.test', role: 'member' })
    expect(updated.status).toBe('updated')
    expect(updated.principalId).toBe(created.principalId)
    expect(updated.role).toBe('member')

    const inOrg = await services.resolveActor({ orgId: org.id, principalId: created.principalId })
    expect(inOrg.role).toBe('member')
  })

  it('refuses to invite an email anchored to another workspace', async () => {
    // Ada founds org A; Bo (owner of B) tries to invite Ada's email into B.
    const { org: orgA } = await bootstrap()
    const { org: orgB } = await services.orgs.bootstrap({
      org: { slug: 'beta', name: 'Beta', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@beta.test', name: 'Bo', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({
      orgId: orgB.id,
      principalId: (await db.repositories.principals.listByOrg(orgB.id))[0]!.id,
    })
    await expect(
      services.members.invite(ownerB, { email: 'ada@acme.test', role: 'member' }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(orgA.id).not.toBe(orgB.id)
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

// --- member listing ---------------------------------------------------------

describe('member listing', () => {
  it('lists org members with their effective role (owner first)', async () => {
    const { org, owner } = await bootstrap()
    await makeUser(org.id, owner, 'member')
    const members = await services.members.listOrg(owner)
    expect(members).toHaveLength(2)
    expect(members[0]?.role).toBe('owner')
    expect(members.some((m) => m.role === 'member')).toBe(true)
    expect(members.every((m) => typeof m.displayName === 'string')).toBe(true)
  })
})

// --- cross-workspace membership ---------------------------------------------

describe('cross-workspace membership', () => {
  it('lets one account join a second workspace by redeeming an invite', async () => {
    // Two independent tenants with two different founders.
    const { org: orgA, owner: ownerA } = await bootstrap()
    const { org: orgB } = await services.orgs.bootstrap({
      org: { slug: 'beta', name: 'Beta', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@beta.test', name: 'Bo', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({
      orgId: orgB.id,
      principalId: (await db.repositories.principals.listByOrg(orgB.id))[0]!.id,
    })

    // Bo (owner of B) mints a join code; Ada (founder of A) redeems it.
    const invite = await services.invites.create(ownerB, { role: 'member' })
    const result = await services.invites.redeem(
      { authUserId: 'auth-ada', email: 'ada@acme.test', name: 'Ada' },
      { code: invite.code },
    )

    expect(result.org.id).toBe(orgB.id)
    expect(result.role).toBe('member')

    // Ada's account now owns one principal per org: A (home) and B (joined).
    const ada = await db.repositories.users.getByEmail('ada@acme.test')
    const principals = await db.repositories.principals.listByUserId(ada!.id)
    expect(principals.map((p) => p.orgId).sort()).toEqual([orgA.id, orgB.id].sort())

    // She acts as owner in A and member in B with the same account.
    const inA = await services.resolveActor({ orgId: orgA.id, principalId: ada!.principalId })
    expect(inA.role).toBe('owner')
    const inB = await services.resolveActor({ orgId: orgB.id, principalId: result.principalId })
    expect(inB.role).toBe('member')
    expect(ownerA.orgId).toBe(orgA.id)
  })

  it('is idempotent when the same account redeems a second code for the same org', async () => {
    const { org: orgB } = await services.orgs.bootstrap({
      org: { slug: 'beta', name: 'Beta', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@beta.test', name: 'Bo', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({
      orgId: orgB.id,
      principalId: (await db.repositories.principals.listByOrg(orgB.id))[0]!.id,
    })
    const acct = { authUserId: 'auth-cy', email: 'cy@x.test', name: 'Cy' }

    const first = await services.invites.create(ownerB, { role: 'viewer' })
    const r1 = await services.invites.redeem(acct, { code: first.code })
    const second = await services.invites.create(ownerB, { role: 'member' })
    const r2 = await services.invites.redeem(acct, { code: second.code })

    // Same principal reused (no duplicate principal in the org).
    expect(r2.principalId).toBe(r1.principalId)
    const cy = await db.repositories.users.getByEmail('cy@x.test')
    const principals = await db.repositories.principals.listByUserId(cy!.id)
    expect(principals.filter((p) => p.orgId === orgB.id)).toHaveLength(1)
  })
})

// --- crow notifications -----------------------------------------------------

describe('crow notifier', () => {
  it('delivers a crow event to a wired notifier', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const events: CrowEvent[] = []
    const notified = createServices(db.repositories, {
      crowNotifier: { notify: (e) => void events.push(e) },
    })
    const ticket = await notified.tickets.create(owner, { projectId: project.id, title: 'wake me' })

    await notified.tickets.crow(owner, ticket.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.ticketKey).toBe(ticket.key)
    expect(events[0]?.byPrincipalId).toBe(owner.principalId)
  })

  it('never fails the crow when delivery throws', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const boom = createServices(db.repositories, {
      crowNotifier: {
        notify: () => {
          throw new Error('webhook down')
        },
      },
    })
    const ticket = await boom.tickets.create(owner, { projectId: project.id, title: 'x' })
    const res = await boom.tickets.crow(owner, ticket.id)
    expect(res.ticket.id).toBe(ticket.id)
  })
})

// --- workspaces -------------------------------------------------------------

describe('listWorkspaces', () => {
  it('lists the orgs the account belongs to, marking the current one', async () => {
    const { org, owner } = await bootstrap()
    const ws = await services.orgs.listWorkspaces(owner)
    expect(ws).toEqual([{ orgId: org.id, slug: 'acme', name: 'Acme', current: true }])
  })
})

describe('createWorkspace', () => {
  it('creates a second workspace owned by the same account', async () => {
    const { owner } = await bootstrap()
    const res = await services.orgs.createWorkspace(owner, {
      workspace: { name: 'Second' },
      project: { name: 'Core', key: 'SEC' },
    })
    expect(res.org.slug).toBe('second')
    expect(res.project.key).toBe('SEC')

    // The account now belongs to both orgs.
    const ws = await services.orgs.listWorkspaces(owner)
    expect(ws.map((w) => w.orgId).sort()).toEqual([owner.orgId, res.org.id].sort())

    // The caller is owner in the new org and can file a ticket there.
    const newOwner = await services.resolveActor({
      orgId: res.org.id,
      principalId: res.founder.id,
    })
    expect(newOwner.role).toBe('owner')
    const t = await services.tickets.create(newOwner, { projectId: res.project.id, title: 'hi' })
    expect(t.key).toBe('SEC-1')
  })

  it('rejects an agent (single-org, no account)', async () => {
    const { org } = await bootstrap()
    const agent = await db.repositories.principals.create(org.id, {
      type: 'agent',
      displayName: 'bot',
    })
    const agentActor: Actor = {
      orgId: org.id,
      principalId: agent.id,
      type: 'agent',
      role: 'owner',
      scopes: [],
    }
    await expect(
      services.orgs.createWorkspace(agentActor, {
        workspace: { name: 'X' },
        project: { name: 'P', key: 'XXX' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- milestones --------------------------------------------------------------

describe('milestones', () => {
  it('creates milestones, scopes tickets to them, and filters by milestone', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)

    const m = await services.milestones.create(owner, {
      projectId: project.id,
      name: 'Sprint 1',
      dueDate: '2026-08-01',
    })
    expect(m.name).toBe('Sprint 1')
    expect((await services.milestones.list(owner, project.id)).map((x) => x.id)).toEqual([m.id])

    const inSprint = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'a',
      milestoneId: m.id,
    })
    await services.tickets.create(owner, { projectId: project.id, title: 'b' }) // no milestone
    expect(inSprint.milestoneId).toBe(m.id)

    const filtered = await services.tickets.list(owner, project.id, { milestoneId: m.id })
    expect(filtered.map((t) => t.id)).toEqual([inSprint.id])
  })

  it('rejects a ticket pointed at a milestone that does not exist', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    await expect(
      services.tickets.create(owner, {
        projectId: project.id,
        title: 'x',
        milestoneId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// --- watchers + notifications -----------------------------------------------

describe('watchers', () => {
  it('watch/unwatch is idempotent and powers listWatchers + myWatches', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'follow me' })
    const bob = await makeUser(org.id, owner, 'member')

    await services.watchers.watch(bob, { ticketId: t.id })
    await services.watchers.watch(bob, { ticketId: t.id }) // idempotent
    expect(await services.watchers.listWatchers(owner, t.id)).toHaveLength(1)
    expect((await services.watchers.myWatches(bob)).map((x) => x.id)).toEqual([t.id])

    expect(await services.watchers.unwatch(bob, { ticketId: t.id })).toEqual({ removed: true })
    expect(await services.watchers.myWatches(bob)).toEqual([])
  })

  it('notifies watchers minus the actor on status, assignment and comment', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const events: NotificationEvent[] = []
    const svc = createServices(db.repositories, {
      crowNotifier: { notify: (e) => void events.push(e) },
    })
    const bob = await makeUser(org.id, owner, 'member')
    const t = await svc.tickets.create(owner, { projectId: project.id, title: 'x' })
    await svc.watchers.watch(owner, { ticketId: t.id })
    await svc.watchers.watch(bob, { ticketId: t.id })

    await svc.tickets.changeStatus(owner, { ticketId: t.id, status: 'in_progress' })
    expect(events.find((e) => e.kind === 'status')?.recipientIds).toEqual([bob.principalId])

    await svc.comments.create(bob, { ticketId: t.id, body: 'hi' })
    expect(events.find((e) => e.kind === 'comment')?.recipientIds).toEqual([owner.principalId])
  })

  it('auto-follows the assignee on assignment', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    const bob = await makeUser(org.id, owner, 'member')

    await services.tickets.assign(owner, { ticketId: t.id, assigneeId: bob.principalId })
    expect((await services.watchers.listWatchers(owner, t.id)).map((w) => w.principalId)).toEqual([
      bob.principalId,
    ])
  })
})

// --- multiple assignees -----------------------------------------------------

describe('multiple assignees', () => {
  it('lists the primary plus co-assignees, deduped', async () => {
    const { org, owner, founder } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'shared' })
    const bob = await makeUser(org.id, owner, 'member')

    await services.tickets.assign(owner, { ticketId: t.id, assigneeId: founder.id })
    expect(
      await services.tickets.addAssignee(owner, {
        ticketId: t.id,
        principalId: bob.principalId,
      }),
    ).toEqual({ added: true })

    const ids = await services.tickets.listAssignees(owner, t.id)
    expect([...ids].sort()).toEqual([founder.id, bob.principalId].sort())
  })

  it('add is idempotent and auto-follows the co-assignee', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    const bob = await makeUser(org.id, owner, 'member')

    await services.tickets.addAssignee(owner, { ticketId: t.id, principalId: bob.principalId })
    await services.tickets.addAssignee(owner, { ticketId: t.id, principalId: bob.principalId })

    expect(await services.tickets.listAssignees(owner, t.id)).toEqual([bob.principalId])
    expect((await services.watchers.listWatchers(owner, t.id)).map((w) => w.principalId)).toEqual([
      bob.principalId,
    ])
  })

  it('my_tickets unions primary and co-assignee tickets', async () => {
    const { org, owner, founder } = await bootstrap()
    const { project } = await makeProject(owner)
    const bob = await makeUser(org.id, owner, 'member')

    const primary = await services.tickets.create(owner, { projectId: project.id, title: 'mine' })
    await services.tickets.assign(owner, { ticketId: primary.id, assigneeId: bob.principalId })

    const shared = await services.tickets.create(owner, { projectId: project.id, title: 'ours' })
    await services.tickets.assign(owner, { ticketId: shared.id, assigneeId: founder.id })
    await services.tickets.addAssignee(owner, { ticketId: shared.id, principalId: bob.principalId })

    const mine = await services.tickets.myTickets(bob)
    expect(mine.map((x) => x.id).sort()).toEqual([primary.id, shared.id].sort())
  })

  it('removing the primary clears assigneeId; removing a co-assignee drops the join', async () => {
    const { org, owner, founder } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    const bob = await makeUser(org.id, owner, 'member')

    await services.tickets.assign(owner, { ticketId: t.id, assigneeId: founder.id })
    await services.tickets.addAssignee(owner, { ticketId: t.id, principalId: bob.principalId })

    expect(
      await services.tickets.removeAssignee(owner, {
        ticketId: t.id,
        principalId: founder.id,
      }),
    ).toEqual({ removed: true })
    expect((await services.tickets.get(owner, t.id)).assigneeId).toBeNull()
    expect(await services.tickets.listAssignees(owner, t.id)).toEqual([bob.principalId])

    expect(
      await services.tickets.removeAssignee(owner, {
        ticketId: t.id,
        principalId: bob.principalId,
      }),
    ).toEqual({ removed: true })
    expect(await services.tickets.listAssignees(owner, t.id)).toEqual([])
  })
})

// --- batch create + ticket context -----------------------------------------

describe('createMany', () => {
  it('opens several tickets in input order with sequential keys', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)

    const created = await services.tickets.createMany(owner, {
      tickets: [
        { projectId: project.id, title: 'one', priority: 'none', labels: [] },
        { projectId: project.id, title: 'two', priority: 'high', labels: ['infra'] },
        { projectId: project.id, title: 'three', priority: 'none', labels: [] },
      ],
    })
    expect(created.map((t) => t.title)).toEqual(['one', 'two', 'three'])
    expect(created.map((t) => t.key)).toEqual(['ROOST-1', 'ROOST-2', 'ROOST-3'])
  })

  it('rejects the whole batch (no writes) when one entry is invalid', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)

    await expect(
      services.tickets.createMany(owner, {
        tickets: [
          { projectId: project.id, title: 'ok', priority: 'none', labels: [] },
          // Off-scale estimate — the batch parse must fail before any insert.
          { projectId: project.id, title: 'bad', priority: 'none', labels: [], estimate: 7 },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError)

    // Nothing was written.
    expect(await services.tickets.list(owner, project.id)).toEqual([])
  })
})

describe('getContext', () => {
  it('bundles comments, attachments, subtasks, links and assignees in one call', async () => {
    const { org, owner, founder } = await bootstrap()
    const { project } = await makeProject(owner)
    const bob = await makeUser(org.id, owner, 'member')

    const t = await services.tickets.create(owner, { projectId: project.id, title: 'hub' })
    const child = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'sub',
      parentId: t.id,
    })
    const blocked = await services.tickets.create(owner, { projectId: project.id, title: 'later' })

    await services.tickets.assign(owner, { ticketId: t.id, assigneeId: founder.id })
    await services.tickets.addAssignee(owner, { ticketId: t.id, principalId: bob.principalId })
    await services.comments.create(owner, { ticketId: t.id, body: 'first' })
    await services.attachments.add(owner, { ticketId: t.id, url: 'https://e.com/x', label: 'x' })
    await services.tickets.link(owner, {
      fromTicketId: t.id,
      toTicketId: blocked.id,
      type: 'blocks',
    })

    const ctx = await services.tickets.getContext(owner, t.id)
    expect(ctx.ticket.id).toBe(t.id)
    expect(ctx.assignees.sort()).toEqual([founder.id, bob.principalId].sort())
    expect(ctx.comments.map((c) => c.body)).toEqual(['first'])
    expect(ctx.attachments.map((a) => a.url)).toEqual(['https://e.com/x'])
    expect(ctx.subtasks.map((s) => s.id)).toEqual([child.id])
    expect(ctx.links).toEqual([
      { relation: 'blocks', ticketId: blocked.id, key: blocked.key, title: 'later' },
    ])
  })

  it('404s a ticket from another org', async () => {
    const { owner } = await bootstrap()
    const { ticketId } = await bootstrap2()
    await expect(services.tickets.getContext(owner, ticketId)).rejects.toBeInstanceOf(NotFoundError)
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

// --- claim_next (atomic work dispatch) --------------------------------------

describe('claim_next', () => {
  it('claims actionable tickets highest-priority first, then returns null when drained', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const low = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'low',
      priority: 'low',
    })
    const highA = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'high a',
      priority: 'high',
    })
    const highB = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'high b',
      priority: 'high',
    })

    // Both high-priority tickets come before the low one (createdAt breaks ties).
    const first = await services.tickets.claimNext(owner, { projectId: project.id })
    expect(first?.assigneeId).toBe(owner.principalId)
    expect([highA.id, highB.id]).toContain(first?.id)

    const second = await services.tickets.claimNext(owner, { projectId: project.id })
    expect([highA.id, highB.id]).toContain(second?.id)
    expect(second?.id).not.toBe(first?.id)

    const third = await services.tickets.claimNext(owner, { projectId: project.id })
    expect(third?.id).toBe(low.id)

    expect(await services.tickets.claimNext(owner, { projectId: project.id })).toBeNull()
  })

  it('skips a ticket with an unresolved blocker, then frees it once resolved', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const blocker = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'blocker',
      priority: 'low',
    })
    const blocked = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'blocked',
      priority: 'urgent',
    })
    await services.tickets.link(owner, {
      fromTicketId: blocker.id,
      toTicketId: blocked.id,
      type: 'blocks',
    })

    // `blocked` is urgent but blocked, so the low-priority blocker is claimed first.
    const first = await services.tickets.claimNext(owner, { projectId: project.id })
    expect(first?.id).toBe(blocker.id)

    // Resolving the blocker frees the blocked ticket.
    await services.tickets.changeStatus(owner, { ticketId: blocker.id, status: 'in_progress' })
    await services.tickets.changeStatus(owner, { ticketId: blocker.id, status: 'done' })
    const second = await services.tickets.claimNext(owner, { projectId: project.id })
    expect(second?.id).toBe(blocked.id)
  })

  it('only claims unassigned, actionable (backlog/todo) tickets', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const started = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'started',
      priority: 'high',
    })
    await services.tickets.changeStatus(owner, { ticketId: started.id, status: 'in_progress' })
    expect(await services.tickets.claimNext(owner, { projectId: project.id })).toBeNull()
  })

  it('makes the claimer a watcher of the ticket', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    await services.tickets.create(owner, { projectId: project.id, title: 't', priority: 'high' })
    const claimed = await services.tickets.claimNext(owner, { projectId: project.id })
    const watched = await services.watchers.myWatches(owner)
    expect(watched.map((t) => t.id)).toContain(claimed?.id)
  })

  it('never lets two concurrent callers claim the same ticket', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const a = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'a',
      priority: 'high',
    })
    const b = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'b',
      priority: 'high',
    })
    const [r1, r2] = await Promise.all([
      services.tickets.claimNext(owner, { projectId: project.id }),
      services.tickets.claimNext(owner, { projectId: project.id }),
    ])
    expect([r1?.id, r2?.id].sort()).toEqual([a.id, b.id].sort())
  })

  it('requires ticket:write and a real project', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const viewer = await makeUser(org.id, owner, 'viewer')
    await expect(
      services.tickets.claimNext(viewer, { projectId: project.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      services.tickets.claimNext(owner, { projectId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

// --- idempotent ticket creation (ROO-26) ------------------------------------

describe('create_ticket idempotency keys', () => {
  it('returns the original ticket for a repeated key, filing no duplicate', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)

    const first = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'once',
      idempotencyKey: 'dedupe-1',
    })
    const repeat = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'second title is ignored',
      idempotencyKey: 'dedupe-1',
    })

    expect(repeat.id).toBe(first.id)
    expect(repeat.title).toBe('once')
    expect((await services.tickets.list(owner, project.id)).length).toBe(1)
  })

  it('creates distinct tickets for distinct keys, and always for no key', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)

    const a = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'a',
      idempotencyKey: 'k-a',
    })
    const b = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'b',
      idempotencyKey: 'k-b',
    })
    expect(b.id).not.toBe(a.id)

    const n1 = await services.tickets.create(owner, { projectId: project.id, title: 'n' })
    const n2 = await services.tickets.create(owner, { projectId: project.id, title: 'n' })
    expect(n2.id).not.toBe(n1.id)
  })

  it('scopes keys per workspace', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const mine = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'mine',
      idempotencyKey: 'shared-key',
    })

    // Same key in a different org is independent — a separate ticket.
    const other = await services.orgs.bootstrap({
      org: { slug: 'idem-other', name: 'Other', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@idem.test', name: 'Bo', avatarUrl: null },
    })
    const otherOwner = await services.resolveActor({
      orgId: other.org.id,
      principalId: other.founder.id,
    })
    const team = await services.teams.create(otherOwner, { name: 'T' })
    const otherProject = await services.projects.create(otherOwner, {
      teamId: team.id,
      key: 'OTH',
      name: 'P',
    })
    const theirs = await services.tickets.create(otherOwner, {
      projectId: otherProject.id,
      title: 'theirs',
      idempotencyKey: 'shared-key',
    })
    expect(theirs.id).not.toBe(mine.id)
  })
})

// --- optimistic concurrency on updates (ROO-27) -----------------------------

describe('optimistic concurrency (expectedUpdatedAt)', () => {
  const STALE = '2000-01-01T00:00:00.000Z'

  it('applies an update when the guard matches the current updatedAt', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 't' })

    const current = await services.tickets.get(owner, t.id)
    const updated = await services.tickets.update(owner, t.id, {
      title: 'renamed',
      expectedUpdatedAt: current.updatedAt,
    })
    expect(updated.title).toBe('renamed')
  })

  it('rejects update / change_status / assign when the guard is stale', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 't' })

    await expect(
      services.tickets.update(owner, t.id, { title: 'x', expectedUpdatedAt: STALE }),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      services.tickets.changeStatus(owner, {
        ticketId: t.id,
        status: 'todo',
        expectedUpdatedAt: STALE,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      services.tickets.assign(owner, {
        ticketId: t.id,
        assigneeId: owner.principalId,
        expectedUpdatedAt: STALE,
      }),
    ).rejects.toBeInstanceOf(ConflictError)

    // A rejected guarded write applies nothing.
    const after = await services.tickets.get(owner, t.id)
    expect(after.title).toBe('t')
    expect(after.status).toBe('backlog')
  })

  it('preserves last-write-wins when the guard is omitted', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 't' })
    const ok = await services.tickets.update(owner, t.id, { title: 'no guard' })
    expect(ok.title).toBe('no guard')
  })
})

// --- conversation traces ----------------------------------------------------

describe('conversation traces', () => {
  it('appends staged messages with monotonic seq across batches', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'feature' })

    const first = await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'plan',
      messages: [
        { role: 'human', body: 'How should we model stages?' },
        {
          role: 'agent',
          kind: 'text',
          body: 'A fixed enum per message.',
          metadata: { model: 'x' },
        },
      ],
    })
    expect(first.map((m) => m.seq)).toEqual([1, 2])
    // A second flush of the same stage continues the sequence (not from createdAt).
    const second = await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'plan',
      messages: [{ role: 'human', body: 'Sounds good.' }],
    })
    expect(second[0]?.seq).toBe(3)
    expect(second[0]?.authorId).toBe(owner.principalId) // trusted attribution
    expect(second[0]?.metadata).toBeNull()

    const all = await services.conversation.list(owner, { ticketId: t.id })
    expect(all.map((m) => m.body)).toEqual([
      'How should we model stages?',
      'A fixed enum per message.',
      'Sounds good.',
    ])
    // round-trips structured metadata
    expect(all[1]?.metadata).toEqual({ model: 'x' })
  })

  it('filters by stage and is independent of ticket status', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'input',
      messages: [{ role: 'human', body: 'the ask' }],
    })
    await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'execution',
      messages: [{ role: 'agent', body: 'did the thing' }],
    })
    // appending a stage does not move the ticket's status
    expect((await services.tickets.get(owner, t.id)).status).toBe('backlog')

    const exec = await services.conversation.list(owner, { ticketId: t.id, stage: 'execution' })
    expect(exec.map((m) => m.body)).toEqual(['did the thing'])
  })

  it('404s on a missing ticket', async () => {
    const { owner } = await bootstrap()
    await expect(
      services.conversation.append(owner, {
        ticketId: '00000000-0000-4000-8000-000000000000',
        stage: 'plan',
        messages: [{ role: 'human', body: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('gates transcripts behind conversation:read (not ticket:read)', async () => {
    const { org, owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'secret design',
    })
    await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'plan',
      messages: [{ role: 'human', body: 'sensitive transcript' }],
    })

    // An agent with only ticket:* scopes can read the board but NOT the trace.
    const agent = await services.resolveActor({
      orgId: org.id,
      principalId: (await makeUser(org.id, owner, 'member')).principalId,
    })
    const scoped: Actor = { ...agent, type: 'agent', scopes: ['ticket:read', 'ticket:write'] }

    // get_ticket_context omits the conversation for the unscoped actor…
    const ctx = await services.tickets.getContext(scoped, t.id)
    expect(ctx.conversation).toEqual([])
    // …and a direct list is forbidden.
    await expect(services.conversation.list(scoped, { ticketId: t.id })).rejects.toBeInstanceOf(
      ForbiddenError,
    )

    // The owner (a human, role-gated only) sees it in context.
    const ownerCtx = await services.tickets.getContext(owner, t.id)
    expect(ownerCtx.conversation.map((m) => m.body)).toEqual(['sensitive transcript'])
  })

  it('redacts a ticket’s messages (hard delete + audit)', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'plan',
      messages: [
        { role: 'human', body: 'a' },
        { role: 'agent', body: 'b' },
      ],
    })
    expect(await services.conversation.redactForTicket(owner, t.id)).toEqual({ removed: 2 })
    expect(await services.conversation.list(owner, { ticketId: t.id })).toEqual([])
    const audit = await services.audit.list(owner)
    expect(audit.some((e) => e.action === 'conversation.redact')).toBe(true)
  })

  it('isolates messages by org', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    const t = await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    await services.conversation.append(owner, {
      ticketId: t.id,
      stage: 'plan',
      messages: [{ role: 'human', body: 'mine' }],
    })
    const { owner: other } = await (async () => {
      const b = await services.orgs.bootstrap({
        org: { slug: 'isolated', name: 'Iso', enrollmentPolicy: 'open' },
        founder: { displayName: 'Z', email: 'z@iso.test', name: 'Z', avatarUrl: null },
      })
      return { owner: await services.resolveActor({ orgId: b.org.id, principalId: b.founder.id }) }
    })()
    // The other org can't even see the ticket, let alone its messages.
    await expect(services.conversation.list(other, { ticketId: t.id })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })
})

// --- semantic search (embeddings) -------------------------------------------

/**
 * Deterministic 1536-dim bag-of-words embedder for tests: texts that share words
 * land closer in cosine space, so "similar" is meaningful without a real model.
 */
function mockEmbedder() {
  const DIMS = 1536
  return {
    model: 'mock',
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array<number>(DIMS).fill(0)
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0
          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0
          v[h % DIMS] += 1
        }
        return v
      })
    },
  }
}

describe('semantic search', () => {
  it('embeds on create and finds similar tickets across projects in the org', async () => {
    const { owner } = await bootstrap()
    const svc = createServices(db.repositories, { embedder: mockEmbedder() })
    const team = await svc.teams.create(owner, { key: 'AAA', name: 'A' })
    const p1 = await svc.projects.create(owner, { teamId: team.id, key: 'AAA', name: 'A' })
    const p2 = await svc.projects.create(owner, { teamId: team.id, key: 'BBB', name: 'B' })

    const relevant = await svc.tickets.create(owner, {
      projectId: p1.id,
      title: 'Vector similarity search for agents',
      description: 'embed messages and recall by vector similarity',
    })
    await svc.tickets.create(owner, {
      projectId: p2.id,
      title: 'Billing invoice export',
      description: 'monthly CSV of charges',
    })

    const hits = await svc.tickets.findSimilar(owner, 'semantic vector similarity recall', 5)
    // The vector-heavy ticket (in a different project than the billing one) ranks first.
    expect(hits[0]?.id).toBe(relevant.id)
  })

  it('throws a clear error when embeddings are not configured', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    await services.tickets.create(owner, { projectId: project.id, title: 'x' })
    await expect(services.tickets.findSimilar(owner, 'x')).rejects.toBeInstanceOf(ValidationError)
  })

  it('isolates results by org', async () => {
    const svc = createServices(db.repositories, { embedder: mockEmbedder() })
    const a = await bootstrap()
    const { project } = await (async () => {
      const team = await svc.teams.create(a.owner, { key: 'ROOST', name: 'R' })
      return {
        project: await svc.projects.create(a.owner, { teamId: team.id, key: 'AAA', name: 'A' }),
      }
    })()
    await svc.tickets.create(a.owner, { projectId: project.id, title: 'unique alpha topic widget' })

    const b = await services.orgs.bootstrap({
      org: { slug: 'beta', name: 'Beta', enrollmentPolicy: 'open' },
      founder: { displayName: 'B', email: 'b@beta.test', name: 'B', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({ orgId: b.org.id, principalId: b.founder.id })
    expect(await svc.tickets.findSimilar(ownerB, 'unique alpha topic widget', 5)).toEqual([])
  })

  it('backfills tickets created before embeddings were configured', async () => {
    const { owner } = await bootstrap()
    const { project } = await makeProject(owner)
    // Created with NO embedder → not embedded.
    const t = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'searchable later',
    })

    const svc = createServices(db.repositories, { embedder: mockEmbedder() })
    expect(await svc.tickets.findSimilar(owner, 'searchable later', 5)).toEqual([])

    expect(await svc.tickets.backfillEmbeddings(owner, project.id)).toEqual({ embedded: 1 })
    const hits = await svc.tickets.findSimilar(owner, 'searchable later', 5)
    expect(hits.map((h) => h.id)).toContain(t.id)
  })
})
