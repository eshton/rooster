import { humanIdentityFromSessionEmail } from '@rooster/auth'
import { loadConfig } from '@rooster/config'
import type { Actor } from '@rooster/core'
import type { Project, Ticket } from '@rooster/schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { createServerContext, type ServerContext } from '../context.js'
import * as v from './views.js'

const actor: Actor = { orgId: 'o', principalId: 'p', type: 'user', role: 'owner', scopes: [] }

describe('dashboard views (pure)', () => {
  it('escapes untrusted text', () => {
    expect(v.esc('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;')
  })

  it('renders a board grouped by status with escaped titles', () => {
    const project = { id: 'pr', name: 'Core', description: null } as unknown as Project
    const tickets = [
      { id: 't1', key: 'ROOST-1', title: '<x>', status: 'todo', labels: ['infra'] },
      { id: 't2', key: 'ROOST-2', title: 'Two', status: 'done', labels: [] },
    ] as unknown as Ticket[]
    const html = v.projectBoard({ project, tickets, actor })
    expect(html).toContain('To do')
    expect(html).toContain('ROOST-1')
    expect(html).toContain('&lt;x&gt;') // escaped, not raw
    expect(html).not.toContain('<x>')
  })

  it('login page offers configured providers', () => {
    expect(v.loginPage({ providers: ['github'] })).toContain('Continue with github')
  })
})

describe('dashboard (authenticated)', () => {
  let ctx: ServerContext
  let app: ReturnType<typeof createApp>
  let cookie = ''
  const base = 'http://localhost:3000'

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
      ROOSTER_BASE_URL: base,
    })
    ctx = await createServerContext(config, { migrate: true })
    app = createApp(ctx)

    // Onboard a tenant (creates the domain user ada@acme.test).
    await app.request(`${base}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        org: { slug: 'acme', name: 'Acme' },
        founder: { name: 'Ada', email: 'ada@acme.test' },
        team: { key: 'ROOST', name: 'Roost' },
        project: { name: 'Core' },
      }),
    })

    // Sign up a better-auth user with the same email → sets a session cookie.
    const res = await app.request(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@acme.test', password: 'supersecret123' }),
    })
    const setCookies = res.headers.getSetCookie?.() ?? []
    cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  })

  afterAll(async () => {
    await ctx.db.close()
  })

  it('redirects anonymous visitors to login', async () => {
    const res = await app.request(`${base}/app`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/app/login')
  })

  it('serves the login page', async () => {
    const res = await app.request(`${base}/app/login`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Sign in')
  })

  it('renders the org overview for a signed-in member', async () => {
    expect(cookie).not.toBe('')
    const res = await app.request(`${base}/app`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Acme')
    expect(html).toContain('ROOST')
  })

  it('renders the agent registry', async () => {
    const res = await app.request(`${base}/app/agents`, { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Agent registry')
  })

  // --- write actions --------------------------------------------------------

  function form(fields: Record<string, string>) {
    return {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }
  }

  it('creates a ticket, moves it, comments on it — all from the UI', async () => {
    // discover the project id from the overview
    const overview = await (await app.request(`${base}/app`, { headers: { cookie } })).text()
    const projectId = overview.match(/\/app\/projects\/([0-9a-f-]{36})/)?.[1]
    expect(projectId).toBeTruthy()

    const created = await app.request(`${base}/app/projects/${projectId}/tickets`, {
      ...form({ title: 'Dashboard-made ticket', labels: 'ui, infra' }),
    })
    expect(created.status).toBe(302)

    const board = await (
      await app.request(`${base}/app/projects/${projectId}`, { headers: { cookie } })
    ).text()
    expect(board).toContain('Dashboard-made ticket')
    const ticketId = board.match(/\/app\/tickets\/([0-9a-f-]{36})/)?.[1]
    expect(ticketId).toBeTruthy()

    const moved = await app.request(`${base}/app/tickets/${ticketId}/status`, {
      ...form({ status: 'todo' }),
    })
    expect(moved.status).toBe(302)

    const commented = await app.request(`${base}/app/tickets/${ticketId}/comments`, {
      ...form({ body: 'looks good' }),
    })
    expect(commented.status).toBe(302)

    const detail = await (
      await app.request(`${base}/app/tickets/${ticketId}`, { headers: { cookie } })
    ).text()
    expect(detail).toContain('To do') // status moved
    expect(detail).toContain('looks good') // comment shown
  })

  it('rejects an illegal status move with a 400', async () => {
    const overview = await (await app.request(`${base}/app`, { headers: { cookie } })).text()
    const projectId = overview.match(/\/app\/projects\/([0-9a-f-]{36})/)?.[1]
    await app.request(`${base}/app/projects/${projectId}/tickets`, {
      ...form({ title: 'Another ticket' }),
    })
    const board = await (
      await app.request(`${base}/app/projects/${projectId}`, { headers: { cookie } })
    ).text()
    // newest ticket is first in each column; grab any ticket id
    const ticketId = board.match(/\/app\/tickets\/([0-9a-f-]{36})/)?.[1]
    const res = await app.request(`${base}/app/tickets/${ticketId}/status`, {
      ...form({ status: 'done' }), // backlog -> done is illegal
    })
    expect(res.status).toBe(400)
  })

  it('manages an agent (suspend + bind) from the registry', async () => {
    // Register an agent in this tenant via the core services (owner actor).
    const identity = await humanIdentityFromSessionEmail(ctx.db.repositories, 'ada@acme.test')
    const owner = await ctx.services.resolveActor(identity ?? { orgId: '', principalId: '' })
    const agent = await ctx.services.agents.register(owner, {
      displayName: 'Registry Bot',
      kind: 'custom',
      scopes: ['ticket:read'],
    })

    const suspended = await app.request(`${base}/app/agents/${agent.id}/status`, {
      ...form({ status: 'suspended' }),
    })
    expect(suspended.status).toBe(302)

    const bound = await app.request(`${base}/app/agents/${agent.id}/bind`, {
      ...form({ clientId: 'cf-client-123' }),
    })
    expect(bound.status).toBe(302)

    const page = await (await app.request(`${base}/app/agents`, { headers: { cookie } })).text()
    expect(page).toContain('Registry Bot')
    expect(page).toContain('suspended')
    expect(page).toContain('cf-client-123')
  })

  it('redirects anonymous write attempts to login', async () => {
    const res = await app.request(`${base}/app/tickets/whatever/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ body: 'x' }).toString(),
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/app/login')
  })
})
