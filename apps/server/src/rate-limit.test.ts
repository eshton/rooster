import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DbRateLimiter, RateLimiter } from './rate-limit.js'

describe('RateLimiter', () => {
  it('allows up to max within a window, then blocks', () => {
    const rl = new RateLimiter(3, 60_000)
    const now = 1_000
    expect(rl.check('a', now).allowed).toBe(true)
    expect(rl.check('a', now).allowed).toBe(true)
    const third = rl.check('a', now)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)
    const fourth = rl.check('a', now)
    expect(fourth.allowed).toBe(false)
    expect(fourth.retryAfterSeconds).toBe(60)
  })

  it('resets after the window elapses', () => {
    const rl = new RateLimiter(1, 60_000)
    expect(rl.check('a', 0).allowed).toBe(true)
    expect(rl.check('a', 100).allowed).toBe(false)
    expect(rl.check('a', 60_000).allowed).toBe(true)
  })

  it('tracks keys independently', () => {
    const rl = new RateLimiter(1, 60_000)
    expect(rl.check('a', 0).allowed).toBe(true)
    expect(rl.check('b', 0).allowed).toBe(true)
    expect(rl.check('a', 0).allowed).toBe(false)
  })

  it('disables limiting when max <= 0', () => {
    const rl = new RateLimiter(0)
    for (let i = 0; i < 1000; i++) expect(rl.check('a', 0).allowed).toBe(true)
  })
})

describe('DbRateLimiter (shared store)', () => {
  let db: Database
  beforeEach(async () => {
    db = await createDatabase(
      loadConfig({
        DATABASE_URL: 'file::memory:',
        ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
      }),
      { migrate: true },
    )
  })
  afterEach(async () => {
    await db.close()
  })

  it('limits within a window and resets after it', async () => {
    const rl = new DbRateLimiter(db.repositories, 2, 1000)
    const t = 1_000_000
    expect((await rl.check('k', t)).allowed).toBe(true) // 1st
    expect((await rl.check('k', t)).allowed).toBe(true) // 2nd
    const third = await rl.check('k', t)
    expect(third.allowed).toBe(false) // 3rd > max 2
    expect(third.retryAfterSeconds).toBeGreaterThan(0)
    // once the window elapses, the counter resets
    expect((await rl.check('k', t + 1001)).allowed).toBe(true)
  })

  it('keys are independent', async () => {
    const rl = new DbRateLimiter(db.repositories, 1, 1000)
    expect((await rl.check('a', 1)).allowed).toBe(true)
    expect((await rl.check('b', 1)).allowed).toBe(true)
    expect((await rl.check('a', 1)).allowed).toBe(false)
  })
})
