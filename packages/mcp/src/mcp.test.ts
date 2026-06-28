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

  it('claim_next atomically assigns the next actionable ticket, then reports an empty board', async () => {
    const team = await services.teams.create(owner, { key: 'CLM', name: 'Claim' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'CLM',
      name: 'P',
    })
    await services.tickets.create(owner, {
      projectId: project.id,
      title: 'urgent work',
      priority: 'urgent',
    })

    const claimed = payload((await call('claim_next', { projectId: project.id })) as never)
    expect(claimed.claimed).toBe(true)
    expect(claimed.ticket.assigneeId).toBe(owner.principalId)
    expect(claimed.ticket.key).toBe('CLM-1')

    // Only ticket is now taken → nothing left to claim.
    const empty = payload((await call('claim_next', { projectId: project.id })) as never)
    expect(empty.claimed).toBe(false)
    expect(empty.ticket).toBeNull()
  })

  it('dedupes create_ticket by idempotencyKey', async () => {
    const team = await services.teams.create(owner, { key: 'IDM', name: 'Idem' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'IDM',
      name: 'P',
    })

    const first = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'retry-safe',
        idempotencyKey: 'abc-123',
      })) as never,
    )
    const repeat = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'ignored on repeat',
        idempotencyKey: 'abc-123',
      })) as never,
    )
    expect(repeat.id).toBe(first.id)
    expect(repeat.title).toBe('retry-safe')
  })

  it('guards update_ticket with expectedUpdatedAt (optimistic concurrency)', async () => {
    const team = await services.teams.create(owner, { key: 'OCC', name: 'Occ' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'OCC',
      name: 'P',
    })
    const created = payload(
      (await call('create_ticket', { projectId: project.id, title: 'guarded' })) as never,
    )

    // A stale guard is rejected as a conflict, not applied.
    const conflict = (await call('update_ticket', {
      id: created.id,
      title: 'nope',
      expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
    })) as { isError?: boolean; content: Array<{ text?: string }> }
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0]?.text).toContain('conflict')

    // The matching guard applies.
    const fresh = payload((await call('get_ticket', { id: created.id })) as never)
    const ok = payload(
      (await call('update_ticket', {
        id: created.id,
        title: 'applied',
        expectedUpdatedAt: fresh.updatedAt,
      })) as never,
    )
    expect(ok.title).toBe('applied')
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

  it('manages co-assignees alongside the primary', async () => {
    const team = await services.teams.create(owner, { key: 'COO', name: 'Co' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'COO',
      name: 'P',
    })
    const created = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'pair work',
        assigneeId: owner.principalId,
      })) as never,
    )

    // A second principal to share ownership with.
    const bob = await db.repositories.principals.create(owner.orgId, {
      type: 'agent',
      displayName: 'Bob',
    })

    expect(
      payload(
        (await call('add_assignee', {
          ticketId: created.id,
          principalId: bob.id,
        })) as never,
      ),
    ).toEqual({ added: true })

    const assignees = payload(
      (await call('list_assignees', { ticketId: created.id })) as never,
    ) as string[]
    expect([...assignees].sort()).toEqual([owner.principalId, bob.id].sort())

    // Removing a co-assignee leaves the primary intact.
    expect(
      payload(
        (await call('remove_assignee', {
          ticketId: created.id,
          principalId: bob.id,
        })) as never,
      ),
    ).toEqual({ removed: true })
    expect(payload((await call('list_assignees', { ticketId: created.id })) as never)).toEqual([
      owner.principalId,
    ])
  })

  it('batch-creates tickets and reads one ticket context in a single call', async () => {
    const team = await services.teams.create(owner, { key: 'BAT', name: 'Batch' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'BAT',
      name: 'P',
    })

    // create_tickets: three at once, sequential keys, input order preserved.
    const batch = payload(
      (await call('create_tickets', {
        tickets: [
          { projectId: project.id, title: 'first' },
          { projectId: project.id, title: 'second', labels: ['infra'] },
          { projectId: project.id, title: 'third' },
        ],
      })) as never,
    ) as Array<{ key: string; title: string; id: string }>
    expect(batch.map((t) => t.key)).toEqual(['BAT-1', 'BAT-2', 'BAT-3'])

    // compact list returns the trimmed shape only.
    const compact = payload(
      (await call('list_tickets', { projectId: project.id, compact: true })) as never,
    ) as Array<Record<string, unknown>>
    expect(Object.keys(compact[0] ?? {}).sort()).toEqual([
      'assigneeId',
      'id',
      'key',
      'priority',
      'status',
      'title',
    ])

    // get_ticket_context bundles related data. Add a comment + subtask first.
    const hub = batch[0]
    await call('comment', { ticketId: hub.id, body: 'hello' })
    await call('create_ticket', { projectId: project.id, title: 'kid', parentId: hub.id })

    const ctx = payload((await call('get_ticket_context', { key: 'BAT-1' })) as never) as {
      ticket: { id: string }
      comments: unknown[]
      subtasks: unknown[]
      assignees: string[]
    }
    expect(ctx.ticket.id).toBe(hub.id)
    expect(ctx.comments).toHaveLength(1)
    expect(ctx.subtasks).toHaveLength(1)
  })

  it('records and reads a staged conversation trace through tools', async () => {
    const team = await services.teams.create(owner, { key: 'CONV', name: 'Conv' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'CONV',
      name: 'Conv',
    })
    const ticket = payload(
      (await call('create_ticket', { projectId: project.id, title: 'design auth' })) as never,
    )

    const appended = payload(
      (await call('append_messages', {
        ticketId: ticket.id,
        stage: 'plan',
        messages: [
          { role: 'human', body: 'How should agents recall past discussions?' },
          { role: 'agent', body: 'Embed messages and search by vector, scoped to the org.' },
        ],
      })) as never,
    ) as Array<{ seq: number; role: string }>
    expect(appended.map((m) => m.seq)).toEqual([1, 2])

    const listed = payload(
      (await call('list_messages', { ticketId: ticket.id, stage: 'plan' })) as never,
    ) as Array<{ body: string }>
    expect(listed).toHaveLength(2)

    // The trace also surfaces in the one-call context bundle.
    const ctx = payload((await call('get_ticket_context', { id: ticket.id })) as never) as {
      conversation: Array<{ role: string; stage: string }>
    }
    expect(ctx.conversation).toHaveLength(2)
    expect(ctx.conversation[0]?.stage).toBe('plan')
  })

  it('creates teams + projects and invites a teammate by email', async () => {
    const team = payload((await call('create_team', { key: 'OPS', name: 'Ops' })) as never)
    expect(team.key).toBe('OPS')

    const project = payload(
      (await call('create_project', { teamId: team.id, key: 'RUN', name: 'Runbooks' })) as never,
    )
    expect(project.name).toBe('Runbooks')
    expect(project.key).toBe('RUN')

    // Milestone: create, then file a ticket into it and filter by it.
    const milestone = payload(
      (await call('create_milestone', { projectId: project.id, name: 'Sprint 1' })) as never,
    )
    expect(milestone.name).toBe('Sprint 1')
    const inSprint = payload(
      (await call('create_ticket', {
        projectId: project.id,
        title: 'scoped',
        milestoneId: milestone.id,
      })) as never,
    )
    const filtered = payload(
      (await call('list_tickets', { projectId: project.id, milestoneId: milestone.id })) as never,
    ) as Array<{ id: string }>
    expect(filtered.map((t) => t.id)).toEqual([inSprint.id])

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

  it('find_similar_tickets errors clearly when embeddings are unconfigured', async () => {
    // The default harness wires no embedder.
    const res = (await call('find_similar_tickets', { query: 'anything' })) as {
      isError?: boolean
      content: Array<{ text?: string }>
    }
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text ?? '').toMatch(/not configured/i)
  })
})

describe('MCP semantic search (embedder wired)', () => {
  const mockEmbedder = {
    model: 'mock',
    async embed(texts: string[]) {
      return texts.map((t) => {
        const v = new Array<number>(1536).fill(0)
        for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0
          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0
          v[h % 1536] += 1
        }
        return v
      })
    },
  }

  /** A fresh in-memory harness with the embedder wired and a client connected. */
  async function harness() {
    const config = loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    })
    const localDb = await createDatabase(config, { migrate: true })
    const localServices = createServices(localDb.repositories, { embedder: mockEmbedder })
    const { org, founder } = await localServices.orgs.bootstrap({
      org: { slug: 'vec', name: 'Vec', enrollmentPolicy: 'open' },
      founder: { displayName: 'V', email: 'v@vec.test', name: 'V', avatarUrl: null },
    })
    const localOwner = await localServices.resolveActor({ orgId: org.id, principalId: founder.id })
    const server = createRoosterMcpServer({ services: localServices, actor: localOwner })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const localClient = new Client({ name: 'test', version: '1.0' })
    await localClient.connect(ct)
    return { localDb, localServices, localOwner, localClient }
  }

  it('finds a semantically similar ticket through find_similar_tickets', async () => {
    const { localDb, localServices, localOwner, localClient } = await harness()
    const team = await localServices.teams.create(localOwner, { key: 'VEC', name: 'Vec' })
    const project = await localServices.projects.create(localOwner, {
      teamId: team.id,
      key: 'VEC',
      name: 'Vec',
    })
    const target = await localServices.tickets.create(localOwner, {
      projectId: project.id,
      title: 'Vector similarity recall',
      description: 'embed and search by meaning',
    })
    await localServices.tickets.create(localOwner, {
      projectId: project.id,
      title: 'Unrelated billing export',
    })

    const res = await localClient.callTool({
      name: 'find_similar_tickets',
      arguments: { query: 'semantic vector similarity', limit: 3 },
    })
    const hits = payload(res as never) as Array<{ id: string }>
    expect(hits[0]?.id).toBe(target.id)

    await localClient.close()
    await localDb.close()
  })

  it('recalls a conversation message across projects via recall_conversations', async () => {
    const { localDb, localServices, localOwner, localClient } = await harness()
    const team = await localServices.teams.create(localOwner, { key: 'VEC', name: 'Vec' })
    const p1 = await localServices.projects.create(localOwner, {
      teamId: team.id,
      key: 'AAA',
      name: 'A',
    })
    const p2 = await localServices.projects.create(localOwner, {
      teamId: team.id,
      key: 'BBB',
      name: 'B',
    })
    const t1 = await localServices.tickets.create(localOwner, { projectId: p1.id, title: 'design' })
    const t2 = await localServices.tickets.create(localOwner, { projectId: p2.id, title: 'ops' })
    await localServices.conversation.append(localOwner, {
      ticketId: t1.id,
      stage: 'plan',
      messages: [{ role: 'human', body: 'How do we embed messages for vector recall?' }],
    })
    await localServices.conversation.append(localOwner, {
      ticketId: t2.id,
      stage: 'plan',
      messages: [{ role: 'human', body: 'Rotate the on-call schedule weekly' }],
    })

    const res = await localClient.callTool({
      name: 'recall_conversations',
      arguments: { query: 'embedding vector recall', limit: 5 },
    })
    const hits = payload(res as never) as Array<{ ticketKey: string; snippet: string }>
    expect(hits[0]?.ticketKey).toBe(t1.key) // the message in a different project
    expect(hits[0]?.snippet).toMatch(/vector recall/i)

    // The hit's ticket then yields the full staged thread via get_ticket_context.
    const ctx = payload(
      (await localClient.callTool({
        name: 'get_ticket_context',
        arguments: { key: t1.key },
      })) as never,
    ) as { conversation: unknown[] }
    expect(ctx.conversation).toHaveLength(1)

    await localClient.close()
    await localDb.close()
  })
})
