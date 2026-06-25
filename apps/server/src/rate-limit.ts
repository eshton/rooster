/**
 * Fixed-window, in-memory rate limiter keyed by a string (e.g. a principal id).
 *
 * This is best-effort and per-process: it protects a long-running Node / Docker
 * deployment. On serverless (Vercel / Workers) each invocation has its own
 * memory, so a shared store (KV / Redis / Durable Object) would be needed for
 * cross-instance limits — wire one in here when that day comes.
 */
export interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

export class RateLimiter {
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
