import { unlinkSync } from 'node:fs'
import { loadConfig } from '@rooster/config'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { createServerContext } from './context.js'

// ROO-66: on a real (non-memory) SQLite/libSQL file, better-auth runs through the
// drizzle adapter on the shared connection, so a login survives a restart. We
// sign up on a file DB, then open a FRESH context over the same file and check
// the same session cookie still resolves.

const base = 'http://localhost:3000'
const DB_FILE = `${process.env.TMPDIR ?? '/tmp'}/rooster-durable-auth-${Date.now()}.db`

function cfg() {
  return loadConfig({
    DATABASE_URL: `file:${DB_FILE}`,
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    ROOSTER_BASE_URL: base,
  })
}

describe('durable better-auth sessions on file SQLite (ROO-66)', () => {
  let cookie = ''

  afterAll(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${DB_FILE}${suffix}`)
      } catch {
        /* best-effort cleanup */
      }
    }
  })

  it('signs up and resolves a session on a file DB', async () => {
    const ctx = await createServerContext(cfg(), { migrate: true })
    const app = createApp(ctx)
    const res = await app.request(`${base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ada@durable.test', password: 'supersecret123' }),
    })
    expect(res.status).toBe(200) // drizzle-adapter insert path works
    cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    expect(cookie).not.toBe('')

    const session = await ctx.auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(session?.user.email).toBe('ada@durable.test')
    await ctx.db.close()
  })

  it('the session survives a restart — a fresh context over the same file still resolves it', async () => {
    const ctx = await createServerContext(cfg(), { migrate: true })
    const session = await ctx.auth.api.getSession({ headers: new Headers({ cookie }) })
    expect(session?.user.email).toBe('ada@durable.test') // persisted across the "restart"
    await ctx.db.close()
  })
})
