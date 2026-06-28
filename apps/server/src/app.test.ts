import { loadConfig } from '@rooster/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, extractClientInfo } from './app.js'
import { createServerContext, type ServerContext } from './context.js'

describe('extractClientInfo', () => {
  it('reads structured clientInfo from an MCP initialize body', async () => {
    const req = new Request('http://x/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: { clientInfo: { name: 'Claude Code', version: '2.0' } },
      }),
    })
    expect(await extractClientInfo(req)).toEqual({ name: 'Claude Code', version: '2.0' })
  })

  it('falls back to the User-Agent when there is no MCP clientInfo', async () => {
    const req = new Request('http://x/mcp', { headers: { 'user-agent': 'rooster-agent/1.2' } })
    expect(await extractClientInfo(req)).toEqual({ name: 'rooster-agent/1.2', version: '' })
  })

  it('returns null when neither is present', async () => {
    expect(await extractClientInfo(new Request('http://x/mcp'))).toBeNull()
  })
})

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
  app = createApp(ctx)
})

afterAll(async () => {
  await ctx.db.close()
})

describe('discovery + docs', () => {
  it('serves a landing page', async () => {
    const res = await app.request(`${base}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Rooster')
  })

  it('serves a machine-readable discovery document', async () => {
    const res = await app.request(`${base}/.well-known/rooster`)
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { mcp: { endpoint: string }; oauth: { pkce: string } }
    expect(doc.mcp.endpoint).toBe(`${base}/mcp`)
    expect(doc.oauth.pkce).toBe('required')
  })

  it('serves an agent onboarding guide', async () => {
    const res = await app.request(`${base}/llms.txt`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(`${base}/mcp`)
    expect(text).toContain('Dynamic Client Registration')
  })

  it('has a health check', async () => {
    expect((await app.request(`${base}/healthz`)).status).toBe(200)
  })

  it('404s the public roadmap when none is configured', async () => {
    const res = await app.request(`${base}/roadmap`)
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('No public roadmap')
  })
})

describe('public roadmap (configured)', () => {
  let roadmapCtx: ServerContext
  let roadmapApp: ReturnType<typeof createApp>

  beforeAll(async () => {
    const cfg = loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
      ROOSTER_BASE_URL: base,
      ROOSTER_ROADMAP_ORG_SLUG: 'roadmap-co',
      ROOSTER_ROADMAP_PROJECT_KEY: 'pub',
    })
    roadmapCtx = await createServerContext(cfg, { migrate: true })
    roadmapApp = createApp(roadmapCtx)

    const repos = roadmapCtx.db.repositories
    const org = await repos.orgs.create({
      slug: 'roadmap-co',
      name: 'Roadmap Co',
      enrollmentPolicy: 'token',
    })
    const team = await repos.teams.create(org.id, { key: 'PUB', name: 'Public' })
    const project = await repos.projects.create(org.id, {
      teamId: team.id,
      key: 'PUB',
      name: 'Public Project',
      description: null,
    })
    const seed = (number: number, title: string, priority: string, status: string) =>
      repos.tickets.create(org.id, {
        projectId: project.id,
        key: `PUB-${number}`,
        number,
        title,
        description: null,
        status: status as never,
        priority: priority as never,
        labels: [],
        assigneeId: null,
        parentId: null,
      })
    await seed(1, 'Low priority idea', 'low', 'backlog')
    await seed(2, 'Urgent fire', 'urgent', 'in_progress')
    await seed(3, 'Medium thing', 'medium', 'done')
    await seed(4, 'Dropped work', 'high', 'canceled')
  })

  afterAll(async () => {
    await roadmapCtx.db.close()
  })

  it('renders the configured project sorted by priority, excluding canceled', async () => {
    const res = await roadmapApp.request(`${base}/roadmap`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('Public Project')
    expect(html).toContain('Urgent fire')
    expect(html).toContain('Low priority idea')
    // Canceled tickets are dropped from the public roadmap.
    expect(html).not.toContain('Dropped work')
    // Sorted by priority: urgent appears before medium before low.
    expect(html.indexOf('Urgent fire')).toBeLessThan(html.indexOf('Medium thing'))
    expect(html.indexOf('Medium thing')).toBeLessThan(html.indexOf('Low priority idea'))
  })
})

describe('mounted auth', () => {
  it('exposes the OAuth authorization-server metadata', async () => {
    const res = await app.request(`${base}/api/auth/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.registration_endpoint).toBeTruthy()
  })

  it('mirrors the OAuth metadata at the host root (MCP discovery)', async () => {
    // The issuer is the root, so clients fetch these at `/` — they must resolve
    // to better-auth's /api/auth metadata, not 404.
    for (const wk of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await app.request(`${base}${wk}`)
      expect(res.status, wk).toBe(200)
      expect((await res.json()) as Record<string, unknown>).toBeTruthy()
    }
  })
})

describe('tenant onboarding', () => {
  const tenant = (over: Record<string, unknown> = {}) => ({
    org: { slug: 'acme', name: 'Acme' },
    founder: { name: 'Ada', email: 'ada@acme.test' },
    team: { key: 'ROOST', name: 'Roost' },
    project: { name: 'Henhouse', key: 'HEN' },
    agent: { displayName: 'Backend Claude', kind: 'claude-code', oauthClientId: 'client-xyz' },
    ...over,
  })

  it('provisions org + team + project + bound agent (open self-host)', async () => {
    const res = await app.request(`${base}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(tenant({ org: { slug: 'flock', name: 'Flock' } })),
    })
    expect(res.status).toBe(201)
    const out = (await res.json()) as {
      org: { slug: string }
      team: { key: string }
      agent: { id: string } | null
    }
    expect(out.org.slug).toBe('flock')
    expect(out.team.key).toBe('ROOST')
    expect(out.agent).not.toBeNull()

    // The bound agent is now resolvable by its OAuth client id.
    const bound = await ctx.db.repositories.agents.getByOAuthClientId('client-xyz')
    expect(bound?.id).toBe(out.agent?.id)
  })

  it('rejects invalid input with 400', async () => {
    const res = await app.request(`${base}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ org: { slug: 'x' } }),
    })
    expect(res.status).toBe(400)
  })
})

describe('onboarding signup-token gate', () => {
  it('requires a matching signup token when configured', async () => {
    const cfg = loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
      ROOSTER_BASE_URL: base,
      ROOSTER_SIGNUP_TOKEN: 'let-me-in',
    })
    const gatedCtx = await createServerContext(cfg, { migrate: true })
    const gatedApp = createApp(gatedCtx)
    const body = {
      org: { slug: 'acme', name: 'Acme' },
      founder: { name: 'Ada', email: 'ada@acme.test' },
      team: { key: 'ROOST', name: 'Roost' },
      project: { name: 'Henhouse', key: 'HEN' },
    }

    const denied = await gatedApp.request(`${base}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(denied.status).toBe(403)

    const allowed = await gatedApp.request(`${base}/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, signupToken: 'let-me-in' }),
    })
    expect(allowed.status).toBe(201)
    await gatedCtx.db.close()
  })
})

describe('MCP endpoint', () => {
  it('challenges unauthenticated requests with a 401 + resource metadata', async () => {
    const res = await app.request(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=')
  })
})
