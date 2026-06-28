import type { Actor, ActorCache } from '@rooster/core'

/**
 * The slice of the Cloudflare Workers KV API we use. Declared structurally so
 * the server bundle doesn't depend on `@cloudflare/workers-types`.
 */
export interface KvNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/**
 * KV-backed {@link ActorCache} for the Cloudflare Workers entry: shared across
 * isolates and regions (an in-memory cache would only live within one isolate).
 * Values are JSON; entries expire via KV's native TTL.
 *
 * Note: Workers KV enforces a 60-second minimum `expirationTtl`, so the
 * effective staleness window on the edge is at least 60s even if a shorter TTL
 * is configured — within the accepted self-healing window for role/scope
 * changes.
 */
export class KvActorCache implements ActorCache {
  constructor(private readonly kv: KvNamespace) {}

  async get(key: string): Promise<Actor | undefined> {
    const raw = await this.kv.get(key)
    return raw ? (JSON.parse(raw) as Actor) : undefined
  }

  async set(key: string, actor: Actor, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return
    const ttlSeconds = Math.max(60, Math.ceil(ttlMs / 1000))
    await this.kv.put(key, JSON.stringify(actor), { expirationTtl: ttlSeconds })
  }
}
