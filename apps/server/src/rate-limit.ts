import type { RateLimitRepository } from '@rooster/db'

/**
 * Fixed-window, in-memory rate limiter keyed by a string (e.g. a principal id).
 *
 * This is best-effort and per-process: it protects a long-running Node / Docker
 * deployment. On serverless (Vercel / Workers) each invocation has its own
 * memory, so use {@link DbRateLimiter} for a store shared across instances.
 */
export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

/** A fixed-window rate limiter; in-memory and DB-backed share this shape. */
export interface RateLimitChecker {
  check(key: string, now: number): RateLimitResult | Promise<RateLimitResult>
}

/**
 * Fixed-window limiter backed by the `rate_limits` table — shared across all
 * instances, so it actually limits on serverless/edge (each `check` is a single
 * atomic upsert). Portable across Postgres and libSQL/Turso.
 */
export class DbRateLimiter implements RateLimitChecker {
  constructor(
    private readonly repos: { rateLimits: RateLimitRepository },
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}

  async check(key: string, now: number): Promise<RateLimitResult> {
    if (this.max <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 }
    }
    const nowIso = new Date(now).toISOString()
    const windowFloorIso = new Date(now - this.windowMs).toISOString()
    const { count, windowStart } = await this.repos.rateLimits.hit(key, nowIso, windowFloorIso)
    const allowed = count <= this.max
    const resetAt = Date.parse(windowStart) + this.windowMs
    return {
      allowed,
      remaining: Math.max(0, this.max - count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt - now) / 1000)),
    }
  }
}

export class RateLimiter implements RateLimitChecker {
  private readonly hits = new Map<string, { count: number; resetAt: number }>()

  /**
   * @param max       max requests allowed per window (<= 0 disables limiting)
   * @param windowMs  window length in milliseconds (default 60s)
   */
  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
  ) {}

  check(key: string, now: number): RateLimitResult {
    if (this.max <= 0) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0 }
    }

    // Opportunistically drop expired entries so the map can't grow unbounded.
    if (this.hits.size > 10_000) this.prune(now)

    let entry = this.hits.get(key)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs }
      this.hits.set(key, entry)
    }
    entry.count += 1

    const allowed = entry.count <= this.max
    return {
      allowed,
      remaining: Math.max(0, this.max - entry.count),
      retryAfterSeconds: allowed ? 0 : Math.ceil((entry.resetAt - now) / 1000),
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key)
    }
  }
}
