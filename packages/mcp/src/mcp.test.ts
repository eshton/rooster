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
    const project = await services.projects.create(owner, { teamId: team.id, name: 'Henhouse' })

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
  })

  it('surfaces domain errors as isError results, not crashes', async () => {
    const team = await services.teams.create(owner, { key: 'ROOST', name: 'Roost' })
    const project = await services.projects.create(owner, { teamId: team.id, name: 'P' })
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
