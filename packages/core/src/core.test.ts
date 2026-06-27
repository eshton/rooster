import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from './actor.js'
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
