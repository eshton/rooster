import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { loadConfig } from '@rooster/config'
import { type Actor, createServices, type Services } from '@rooster/core'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoosterMcpServer } from './server.js'

let db: Database
let services: Services
let owner: Actor
let client: Client

/** Parse the JSON text payload of a tool result. */
function payload(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((c) => c.type === 'text')?.text ?? ''
  return JSON.parse(text)
}

beforeEach(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
  db = await createDatabase(config, { migrate: true })
  services = createServices(db.repositories)

  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'open' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  owner = await services.resolveActor({
    orgId: org.id,
    principalId: founder.id,
    clientInfo: { name: 'MCP Test Client', version: '1.0' },
  })

  const server = createRoosterMcpServer({ services, actor: owner })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'test', version: '1.0' })
  await client.connect(clientTransport)
})

afterEach(async () => {
  await client.close()
  await db.close()
})

async function call(name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args })
}

describe('MCP server end-to-end', () => {
  it('advertises the Rooster toolset', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'whoami',
        'create_ticket',
        'change_status',
        'find_by_label',
        'list_subtasks',
        'crow',
      ]),
    )
  })

  it('whoami returns the trusted identity and scopes', async () => {
    const who = payload((await call('whoami')) as never)
    expect(who.principalId).toBe(owner.principalId)
    expect(who.role).toBe('owner')
  })

  it('drives a full ticket workflow through tools', async () => {
    const team = await services.teams.create(owner, { key: 'ROOST', name: 'Roost' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'ROOST',
      name: 'Henhouse',
    })

    const created = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'Wire the MCP server',
        labels: ['mcp', 'infra'],
      })) as never,
    )
    expect(created.key).toBe('ROOST-1')

    const found = payload((await call('find_by_label', { label: 'mcp' })) as never)
    expect(found.map((t: { key: string }) => t.key)).toEqual(['ROOST-1'])

    const moved = payload(
      (await call('change_status', { ticketId: created.id, status: 'in_progress' })) as never,
    )
    expect(moved.status).toBe('in_progress')

    // A resource read returns the same ticket.
    const res = await client.readResource({ uri: 'ticket://ROOST-1' })
    const fromResource = JSON.parse(res.contents[0]?.text as string)
    expect(fromResource.id).toBe(created.id)

    // Linking: a second ticket that the first one blocks.
    const other = payload(
      (await call('create_ticket', { projectId: project.id, title: 'Blocked work' })) as never,
    )
    await call('link_tickets', { fromTicketId: created.id, toTicketId: other.id, type: 'blocks' })
    const links = payload((await call('list_links', { ticketId: other.id })) as never) as Array<{
      relation: string
      key: string
    }>
    expect(links).toEqual([
      {
        relation: 'blocked_by',
        ticketId: created.id,
        key: 'ROOST-1',
        title: 'Wire the MCP server',
      },
    ])

    await call('unlink_tickets', { fromTicketId: created.id, toTicketId: other.id, type: 'blocks' })
    expect(payload((await call('list_links', { ticketId: other.id })) as never)).toEqual([])

    // Attachments: add a link, list it, remove it.
    const att = payload(
      (await call('add_attachment', {
        ticketId: created.id,
        url: 'https://example.com/design.png',
        label: 'Design',
      })) as never,
    )
    expect(att.label).toBe('Design')
    const atts = payload((await call('list_attachments', { ticketId: created.id })) as never)
    expect(atts.map((a: { url: string }) => a.url)).toEqual(['https://example.com/design.png'])
    await call('remove_attachment', { attachmentId: att.id })
    expect(payload((await call('list_attachments', { ticketId: created.id })) as never)).toEqual([])
  })

  it('surfaces domain errors as isError results, not crashes', async () => {
    const team = await services.teams.create(owner, { key: 'ROOST', name: 'Roost' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'ROOST',
      name: 'P',
    })
    const created = payload(
      (await call('create_ticket', { projectId: project.id, title: 'x' })) as never,
    )

    // backlog -> done is illegal in the default workflow.
    const bad = (await call('change_status', { ticketId: created.id, status: 'done' })) as {
      isError?: boolean
      content: Array<{ text?: string }>
    }
    expect(bad.isError).toBe(true)
    expect(bad.content[0]?.text).toContain('validation')
  })

  it('supports due dates, status filters and my_tickets', async () => {
    const team = await services.teams.create(owner, { key: 'DUE', name: 'Due' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'DUE',
      name: 'P',
    })

    // dueDate + estimate + assignee to the owner principal.
    const created = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'With a deadline',
        dueDate: '2026-07-01',
        startDate: '2026-06-15',
        estimate: 3,
        assigneeId: owner.principalId,
      })) as never,
    )
    expect(created.dueDate).toBe('2026-07-01')
    expect(created.startDate).toBe('2026-06-15')
    expect(created.estimate).toBe(3)

    // startDate is editable + clearable like any optional field.
    const rescheduled = payload(
      (await call('update_ticket', { id: created.id, startDate: '2026-06-20' })) as never,
    )
    expect(rescheduled.startDate).toBe('2026-06-20')

    // update_ticket can re-size on the canonical scale and clear the estimate.
    const resized = payload((await call('update_ticket', { id: created.id, estimate: 5 })) as never)
    expect(resized.estimate).toBe(5)
    const cleared = payload(
      (await call('update_ticket', { id: created.id, estimate: null })) as never,
    )
    expect(cleared.estimate).toBe(null)

    // Off-scale estimates are rejected — the scale is enforced, not advisory.
    const offScale = (await call('update_ticket', { id: created.id, estimate: 7 })) as {
      isError?: boolean
    }
    expect(offScale.isError).toBe(true)

    // Status filter: the new ticket is in the initial status, none are 'done'.
    const open = payload(
      (await call('list_tickets', { projectId: project.id, status: created.status })) as never,
    ) as Array<{ id: string }>
    expect(open.some((t) => t.id === created.id)).toBe(true)
    const done = payload(
      (await call('list_tickets', { projectId: project.id, status: 'done' })) as never,
    ) as unknown[]
    expect(done).toHaveLength(0)

    // my_tickets returns tickets assigned to the caller.
    const mine = payload((await call('my_tickets')) as never) as Array<{ id: string }>
    expect(mine.some((t) => t.id === created.id)).toBe(true)

    // search_tickets matches title text (case-insensitive).
    const hits = payload((await call('search_tickets', { query: 'DEADLINE' })) as never) as Array<{
      id: string
    }>
    expect(hits.some((t) => t.id === created.id)).toBe(true)
  })

  it('creates teams + projects and invites a teammate by email', async () => {
    const team = payload((await call('create_team', { key: 'OPS', name: 'Ops' })) as never)
    expect(team.key).toBe('OPS')

    const project = payload(
      (await call('create_project', { teamId: team.id, key: 'RUN', name: 'Runbooks' })) as never,
    )
    expect(project.name).toBe('Runbooks')
    expect(project.key).toBe('RUN')

    const invite = payload(
      (await call('invite_member', { email: 'bob@acme.test', name: 'Bob' })) as never,
    )
    expect(invite.status).toBe('created')
    expect(invite.role).toBe('member')

    const audit = payload((await call('read_audit', { limit: 50 })) as never) as Array<{
      action: string
    }>
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['member.invite']))
  })

  it('re-keys a project and moves a ticket through tools', async () => {
    const team = await services.teams.create(owner, { key: 'ENG', name: 'Eng' })
    const src = await services.projects.create(owner, { teamId: team.id, key: 'SRC', name: 'S' })
    const dst = await services.projects.create(owner, { teamId: team.id, key: 'DST', name: 'D' })
    const t = payload((await call('create_ticket', { projectId: src.id, title: 'x' })) as never)
    expect(t.key).toBe('SRC-1')

    // Rename the source project's prefix — the existing ticket re-keys with it.
    await call('set_project_key', { projectId: src.id, key: 'SRX' })
    expect(payload((await call('get_ticket', { id: t.id })) as never).key).toBe('SRX-1')

    // Move it to the destination project — fresh key + number there.
    const moved = payload(
      (await call('move_ticket', { ticketId: t.id, toProjectId: dst.id })) as never,
    )
    expect(moved.key).toBe('DST-1')
  })

  it('registers, lists and suspends an agent', async () => {
    const reg = payload(
      (await call('register_agent', {
        displayName: 'Worker Bot',
        kind: 'custom',
        scopes: ['ticket:read'],
      })) as never,
    )
    expect(reg.status).toBe('active')

    const agents = payload((await call('list_agents')) as never) as Array<{ id: string }>
    expect(agents.some((a) => a.id === reg.id)).toBe(true)

    const suspended = payload(
      (await call('set_agent_status', { id: reg.id, status: 'suspended' })) as never,
    )
    expect(suspended.status).toBe('suspended')
  })
})
