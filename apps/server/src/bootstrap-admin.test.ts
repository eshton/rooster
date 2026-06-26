import { loadConfig } from '@rooster/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { bootstrapAdmin } from './bootstrap-admin.js'
import { createServerContext, type ServerContext } from './context.js'

describe('self-host: disabled signup + admin bootstrap', () => {
  let ctx: ServerContext
  let app: ReturnType<typeof createApp>
  const base = 'http://localhost:3000'

  beforeAll(async () => {
    const config = loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
      ROOSTER_BASE_URL: base,
      ROOSTER_DISABLE_SIGNUP: 'true',
      ROOSTER_ADMIN_EMAIL: 'admin@acme.test',
      ROOSTER_ADMIN_PASSWORD: 'supersecret123',
      ROOSTER_ADMIN_WORKSPACE: 'Acme HQ',
      ROOSTER_ADMIN_PROJECT_KEY: 'OPS',
    })
    ctx = await createServerContext(config, { migrate: true })
    await bootstrapAdmin(ctx)
    // Idempotent: a second run is a no-op (no duplicate user/org).
    await bootstrapAdmin(ctx)
    app = createApp(ctx)
  })

  afterAll(async () => {
    await ctx.db.close()
  })

  it('provisions the admin account + starter workspace exactly once', async () => {
    const user = await ctx.db.repositories.users.getByEmail('admin@acme.test')
    expect(user).not.toBeNull()
    const principals = await ctx.db.repositories.principals.listByUserId(user!.id)
    expect(principals).toHaveLength(1) // not duplicated by the second bootstrap
    const org = await ctx.db.repositories.orgs.getById(principals[0]!.orgId)
    expect(org?.name).toBe('Acme HQ')
  })

  it('rejects public email/password sign-up with 403', async () => {
    const res = await app.request(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Eve', email: 'eve@acme.test', password: 'supersecret123' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('signup_disabled')
  })

  it('shows the login page as invite-only (no create-account link)', async () => {
    const html = await (await app.request(`${base}/app/login`)).text()
    expect(html).toContain('invite-only')
    expect(html).not.toContain('/app/signup')
  })

  it('closes the signup page with a 403', async () => {
    const res = await app.request(`${base}/app/signup`)
    expect(res.status).toBe(403)
  })

  it('lets the bootstrapped admin sign in and see their workspace', async () => {
    const signIn = await app.request(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@acme.test', password: 'supersecret123' }),
    })
    expect(signIn.ok).toBe(true)
    const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    expect(cookie).not.toBe('')

    const overview = await app.request(`${base}/app`, { headers: { cookie } })
    expect(overview.status).toBe(200)
    expect(await overview.text()).toContain('Acme HQ')
  })
})
