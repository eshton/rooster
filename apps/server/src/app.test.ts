import { loadConfig } from '@rooster/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { createServerContext, type ServerContext } from './context.js'

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
})

describe('mounted auth', () => {
  it('exposes the OAuth authorization-server metadata', async () => {
    const res = await app.request(`${base}/api/auth/.well-known/oauth-authorization-server`)
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.registration_endpoint).toBeTruthy()
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
