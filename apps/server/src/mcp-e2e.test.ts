import { loadConfig } from '@rooster/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { createServerContext, type ServerContext } from './context.js'

/**
 * End-to-end coverage of the account-anchored MCP onboarding flow, driving the
 * real `/mcp` HTTP route with raw JSON-RPC. Authentication is mocked: a stub
 * `auth.api.getMcpUser` maps a fake bearer token to a canned better-auth
 * account, so we exercise identity resolution + tool dispatch without standing
 * up the full OAuth dance. Everything below the auth boundary (services, repos,
 * SQLite) is real.
 *
 * Token → account map. Note tok-ada-claude and tok-ada-opencode share the same
 * account id (`acct-ada`) but differ in client id — that is the "one user, many
 * OAuth clients, one tenant" case.
 */
const ACCOUNTS: Record<
  string,
  { id: string; email: string; name: string; clientId: string; scopes: string }
> = {
  'tok-ada-claude': {
    id: 'acct-ada',
    email: 'ada@acme.test',
    name: 'Ada',
    clientId: 'client-claude',
    scopes: '*',
  },
  'tok-ada-opencode': {
    id: 'acct-ada',
    email: 'ada@acme.test',
    name: 'Ada',
    clientId: 'client-opencode',
    scopes: '*',
  },
  'tok-bob': {
    id: 'acct-bob',
    email: 'bob@acme.test',
    name: 'Bob',
    clientId: 'client-bob',
    scopes: '*',
  },
  'tok-carol': {
    id: 'acct-carol',
    email: 'carol@acme.test',
    name: 'Carol',
    clientId: 'client-carol',
    scopes: '*',
  },
  'tok-dave': {
    id: 'acct-dave',
    email: 'dave@acme.test',
    name: 'Dave',
    clientId: 'client-dave',
    scopes: '*',
  },
}

const stubAuth = {
  handler: async () => new Response(null, { status: 404 }),
  options: {},
  api: {
    getMcpUser: async ({ headers }: { headers: Headers }) => {
      const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      return ACCOUNTS[token] ?? null
    },
  },
}

let ctx: ServerContext
let app: ReturnType<typeof createApp>
const base = 'http://localhost:3000'

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    ROOSTER_BASE_URL: base,
  })
  ctx = await createServerContext(config, { migrate: true })
  // Swap in the stub auth; nothing else about the context changes.
  app = createApp({ ...ctx, auth: stubAuth as unknown as ServerContext['auth'] })
})

afterAll(async () => {
  await ctx.db.close()
})

// --- raw JSON-RPC helpers ---------------------------------------------------

let nextId = 1

/** POST one JSON-RPC request to /mcp as `token`, returning the parsed message. */
async function rpc(token: string | null, method: string, params: unknown) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await app.request(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  })
  return res
}

/** The stateless transport answers POSTs with a one-shot SSE stream. */
async function readSse(res: Response) {
  const text = await res.text()
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'))
  if (!dataLine) throw new Error(`no SSE data frame in response: ${text}`)
  return JSON.parse(dataLine.slice('data:'.length).trim()) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    error?: { code: number; message: string }
  }
}

async function listToolNames(token: string): Promise<string[]> {
  const msg = await readSse(await rpc(token, 'tools/list', {}))
  const tools = (msg.result as { tools?: Array<{ name: string }> }).tools ?? []
  return tools.map((t) => t.name)
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  return readSse(await rpc(token, 'tools/call', { name, arguments: args }))
}

/** Unwrap the JSON payload a Rooster tool returns as its text content. */
function payload(msg: Awaited<ReturnType<typeof callTool>>) {
  const text = msg.result?.content?.find((c) => c.type === 'text')?.text ?? ''
  return JSON.parse(text)
}

// --- scenarios --------------------------------------------------------------

describe('MCP onboarding e2e (account-anchored)', () => {
  let orgId = ''
  let projectId = ''

  it('challenges an unauthenticated /mcp call with 401', async () => {
    const res = await rpc(null, 'tools/list', {})
    expect(res.status).toBe(401)
  })

  it('exposes only whoami + create_tenant to an orgless account', async () => {
    const names = await listToolNames('tok-ada-claude')
    expect(names.sort()).toEqual(['create_tenant', 'join_tenant', 'whoami'])

    // whoami reports the provisional status, not an org actor.
    const who = payload(await callTool('tok-ada-claude', 'whoami'))
    expect(who.status).toBe('provisional')
    expect(who.email).toBe('ada@acme.test')

    // Tenant-data tools are not even registered → JSON-RPC error.
    const denied = await callTool('tok-ada-claude', 'create_ticket', {
      projectId: '00000000-0000-0000-0000-000000000000',
      title: 'nope',
    })
    expect(denied.error ?? denied.result?.isError).toBeTruthy()
  })

  it('bootstraps a workspace via create_tenant', async () => {
    const out = payload(
      await callTool('tok-ada-claude', 'create_tenant', {
        workspace: { name: 'Acme' },
        project: { name: 'Core', key: 'ROOST' },
      }),
    )
    expect(out.workspace.name).toBe('Acme')
    expect(out.workspace.slug).toBe('acme')
    expect(out.team.key).toBe('ROOST')
    orgId = out.workspace.id
    projectId = out.project.id
    expect(orgId).toBeTruthy()
    expect(projectId).toBeTruthy()
  })

  it('gives the same account the full toolset (owner) once it has a workspace', async () => {
    const names = await listToolNames('tok-ada-claude')
    expect(names).toContain('create_ticket')
    expect(names).not.toContain('create_tenant')

    const who = payload(await callTool('tok-ada-claude', 'whoami'))
    expect(who.orgId).toBe(orgId)
    expect(who.role).toBe('owner')
    expect(who.type).toBe('user')

    const ticket = payload(
      await callTool('tok-ada-claude', 'create_ticket', { projectId, title: 'Ship v1' }),
    )
    expect(ticket.key).toBe('ROOST-1')
  })

  it('resolves a different OAuth client of the same account to the same tenant', async () => {
    // tok-ada-opencode: same account id, different client id.
    const who = payload(await callTool('tok-ada-opencode', 'whoami'))
    expect(who.orgId).toBe(orgId)
    expect(who.role).toBe('owner')

    // It sees the ticket the Claude client filed.
    const tickets = payload(await callTool('tok-ada-opencode', 'list_tickets', { projectId }))
    expect(tickets.map((t: { key: string }) => t.key)).toContain('ROOST-1')
  })

  it('grows the workspace: create_team + create_project', async () => {
    const team = payload(
      await callTool('tok-ada-claude', 'create_team', { key: 'OPS', name: 'Operations' }),
    )
    expect(team.key).toBe('OPS')

    const project = payload(
      await callTool('tok-ada-claude', 'create_project', { teamId: team.id, name: 'Runbooks' }),
    )
    expect(project.name).toBe('Runbooks')

    // A ticket in the new project is keyed off the new team.
    const ticket = payload(
      await callTool('tok-ada-claude', 'create_ticket', {
        projectId: project.id,
        title: 'Write the on-call runbook',
      }),
    )
    expect(ticket.key).toBe('OPS-1')
  })

  it('invites a teammate by email; their account links on first login', async () => {
    // Owner invites Bob — no principal/user seeding; the tool provisions them.
    const invite = payload(
      await callTool('tok-ada-claude', 'invite_member', {
        email: 'bob@acme.test',
        name: 'Bob',
        role: 'member',
      }),
    )
    expect(invite.status).toBe('created')
    expect(invite.role).toBe('member')

    // Bob connects for the first time (account id `acct-bob`). resolveMcpIdentity
    // finds his unanchored user by email and links it — he lands in the tenant.
    const who = payload(await callTool('tok-bob', 'whoami'))
    expect(who.orgId).toBe(orgId)
    expect(who.role).toBe('member')

    // And he can file work in the shared workspace.
    const ticket = payload(
      await callTool('tok-bob', 'create_ticket', { projectId, title: "Bob's task" }),
    )
    expect(ticket.key).toBe('ROOST-2')

    // The owner can read the audit trail and see the invite + Bob's ticket.
    const audit = payload(await callTool('tok-ada-claude', 'read_audit', { limit: 50 }))
    const actions = (audit as Array<{ action: string }>).map((a) => a.action)
    expect(actions).toContain('member.invite')
    expect(actions).toContain('ticket.create')
  })

  it('lets a stranger join via a shared invite code', async () => {
    // Owner mints a join code.
    const invite = payload(await callTool('tok-ada-claude', 'create_invite', { role: 'member' }))
    expect(invite.code).toBeTruthy()

    // Carol is orgless — her provisional toolset offers join_tenant.
    const names = await listToolNames('tok-carol')
    expect(names.sort()).toEqual(['create_tenant', 'join_tenant', 'whoami'])

    const joined = payload(await callTool('tok-carol', 'join_tenant', { code: invite.code }))
    expect(joined.workspace.id).toBe(orgId)
    expect(joined.role).toBe('member')

    // On reconnect she resolves to a full member of the shared workspace.
    const who = payload(await callTool('tok-carol', 'whoami'))
    expect(who.orgId).toBe(orgId)
    expect(who.role).toBe('member')

    // A used-up single-use code is rejected for the next (still-provisional) person.
    const reuse = await callTool('tok-dave', 'join_tenant', { code: invite.code })
    expect(reuse.error ?? reuse.result?.isError).toBeTruthy()
  })
})
