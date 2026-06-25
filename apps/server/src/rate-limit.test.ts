import { describe, expect, it } from 'vitest'
import { RateLimiter } from './rate-limit.js'

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
