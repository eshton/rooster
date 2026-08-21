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

  describe('renderMarkdown', () => {
    it('renders headings, bold, inline code and lists', () => {
      const h = v.renderMarkdown('## Title\n\nSome **bold** and `code`.\n\n- one\n- two')
      expect(h).toContain('<h2>Title</h2>')
      expect(h).toContain('<strong>bold</strong>')
      expect(h).toContain('<code>code</code>')
      expect(h).toContain('<ul><li>one</li><li>two</li></ul>')
    })

    it('renders GFM tables', () => {
      const h = v.renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |')
      expect(h).toContain('<table>')
      expect(h).toContain('<th>A</th>')
      expect(h).toContain('<td>1</td>')
    })

    it('renders fenced code blocks without inline formatting inside', () => {
      const h = v.renderMarkdown('```\nconst x = a * b * c\n```')
      expect(h).toContain('<pre class="md-code"><code>')
      expect(h).toContain('const x = a * b * c')
      expect(h).not.toContain('<em>')
    })

    it('renders safe links but drops dangerous schemes', () => {
      expect(v.renderMarkdown('[ok](https://x.test/p)')).toContain(
        '<a href="https://x.test/p" rel="noopener noreferrer">ok</a>',
      )
      const danger = v.renderMarkdown('[click](javascript:alert(1))')
      expect(danger).not.toContain('href')
      expect(danger).toContain('click') // link text kept, href dropped
    })

    it('escapes HTML first — no XSS via markdown', () => {
      const h = v.renderMarkdown('<script>alert(1)</script>\n\n**x**')
      expect(h).not.toContain('<script>')
      expect(h).toContain('&lt;script&gt;')
      expect(h).toContain('<strong>x</strong>') // formatting still works
    })
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
        project: { name: 'Core', key: 'COR' },
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

  it('serves an OAuth-resume login at /login that returns to authorize', async () => {
    const q = '?response_type=code&client_id=abc&redirect_uri=http://localhost:9/cb&state=xyz'
    const res = await app.request(`${base}/login${q}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    // After sign-in the page must navigate back to the MCP authorize endpoint.
    expect(html).toContain('/api/auth/mcp/authorize')
    expect(html).toContain('client_id=abc')
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

  // --- read-only surface (agents-first) -------------------------------------
  // The dashboard performs no domain mutations; data is seeded through the core
  // services (as an agent would over MCP) and the UI only renders it.

  async function ownerActor() {
    const identity = await humanIdentityFromSessionEmail(ctx.db.repositories, 'ada@acme.test')
    return ctx.services.resolveActor(identity ?? { orgId: '', principalId: '' })
  }

  it('renders seeded tickets on the board but shows no write forms', async () => {
    const owner = await ownerActor()
    const [project] = await ctx.services.projects.list(owner)
    await ctx.services.tickets.create(owner, { projectId: project!.id, title: 'Seeded ticket' })

    const board = await app.request(`${base}/app/projects/${project!.id}`, { headers: { cookie } })
    expect(board.status).toBe(200)
    const html = await board.text()
    expect(html).toContain('Seeded ticket') // data renders
    // No mutation affordances anywhere on the board.
    expect(html).not.toContain('<form method="post"')
  })

  it('renders a ticket detail with no status/assign/comment forms', async () => {
    const owner = await ownerActor()
    const [project] = await ctx.services.projects.list(owner)
    const t = await ctx.services.tickets.create(owner, {
      projectId: project!.id,
      title: 'Detail ticket',
    })
    await ctx.services.comments.create(owner, { ticketId: t.id, body: 'a seeded note' })

    const res = await app.request(`${base}/app/tickets/${t.key}`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Detail ticket')
    expect(html).toContain('a seeded note') // comments still shown (read)
    expect(html).not.toContain('<form method="post"')
  })

  it('does not render write forms on the overview or members page', async () => {
    const overview = await (await app.request(`${base}/app`, { headers: { cookie } })).text()
    expect(overview).not.toContain('<form method="post"')
    const members = await (await app.request(`${base}/app/members`, { headers: { cookie } })).text()
    expect(members).not.toContain('<form method="post"')
  })

  // --- mutations are gone (not routed) --------------------------------------

  function post(path: string, fields: Record<string, string> = {}) {
    return app.request(`${base}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    })
  }

  it('has no domain-mutation POST routes (they 404)', async () => {
    const owner = await ownerActor()
    const [project] = await ctx.services.projects.list(owner)
    for (const path of [
      '/app/teams',
      '/app/projects',
      `/app/projects/${project!.id}/tickets`,
      '/app/customers',
    ]) {
      const res = await post(path, { name: 'x', title: 'x', key: 'XXX' })
      expect(res.status).toBe(404)
    }
  })
})
