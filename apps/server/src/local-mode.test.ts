import { loadConfig } from '@rooster/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { bootstrapAdmin } from './bootstrap-admin.js'
import { createServerContext, type ServerContext } from './context.js'

// Local single-user mode (ROO-64): /mcp is gated by a static bearer token
// instead of OAuth, and the dashboard auto-authenticates as the bootstrapped
// local owner. Config only permits this on a localhost base URL.
const base = 'http://localhost:3000'
const TOKEN = 'local-test-token-abcdef'

let ctx: ServerContext
let app: ReturnType<typeof createApp>

beforeAll(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    ROOSTER_BASE_URL: base,
    ROOSTER_LOCAL_MODE: '1',
    ROOSTER_LOCAL_TOKEN: TOKEN,
  })
  ctx = await createServerContext(config, { migrate: true })
  await bootstrapAdmin(ctx) // creates the local owner + starter workspace
  app = createApp(ctx)
})

afterAll(async () => {
  await ctx.db.close()
})

function mcp(headers: Record<string, string>) {
  return app.request(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

describe('local mode (ROO-64)', () => {
  it('rejects /mcp with no token', async () => {
    expect((await mcp({})).status).toBe(401)
  })

  it('rejects /mcp with the wrong token', async () => {
    expect((await mcp({ authorization: 'Bearer not-the-local-token' })).status).toBe(401)
  })

  it('accepts /mcp with the token and serves the full owner toolset', async () => {
    const res = await mcp({ authorization: `Bearer ${TOKEN}` })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('create_ticket') // owner sees the write tools
    expect(body).toContain('create_customer')
  })

  it('auto-authenticates the dashboard as the local owner (no login)', async () => {
    const res = await app.request(`${base}/app`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('My Workspace') // the bootstrapped owner's overview
    expect(html).not.toContain('Sign in') // not the login page
  })
})
