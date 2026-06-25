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
})
