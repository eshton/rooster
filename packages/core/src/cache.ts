import type { Actor } from './actor.js'

/**
 * A short-TTL cache of resolved {@link Actor}s, keyed by an opaque string. The
 * transport keys it by a hash of the bearer token plus the selected org — never
 * the raw token. It lets the stateless `/mcp` hot path skip the full identity
 * resolution chain (token validation → principal + membership lookup) on
 * repeated calls within the TTL window.
 *
 * Staleness is bounded by the TTL: a role / scope / membership change (or a
 * token revocation) self-heals within the window, with no explicit
 * invalidation — an accepted trade-off for a 30–60s window. NEVER cache
 * anything request-specific (e.g. `clientInfo`); the transport overlays that
 * fresh on every request.
 *
 * Portable by design: the Node entry uses {@link InMemoryActorCache}; an edge
 * entry can supply a KV-backed implementation of the same interface.
 */
export interface ActorCache {
  /** The cached actor for `key`, or `undefined` on a miss / expired entry. */
  get(key: string): Promise<Actor | undefined>
  /** Cache `actor` under `key` for `ttlMs`. A non-positive TTL is a no-op. */
  set(key: string, actor: Actor, ttlMs: number): Promise<void>
}

interface Entry {
  actor: Actor
  expiresAt: number
}

/**
 * In-memory {@link ActorCache} with per-entry expiry and a bounded size (LRU:
 * least-recently-used evicted first). Suitable for a long-running Node process
 * and for a reused edge isolate. For cross-instance sharing on serverless, back
 * the cache with a KV store instead.
 */
export class InMemoryActorCache implements ActorCache {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly maxEntries = 1000) {}

  async get(key: string): Promise<Actor | undefined> {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency: re-insert so this key becomes most-recently-used.
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.actor
  }

  async set(key: string, actor: Actor, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    this.entries.delete(key)
    this.entries.set(key, { actor, expiresAt: Date.now() + ttlMs })
    // Evict the oldest (front of insertion order) until within bounds.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
