import type { Actor } from '@rooster/core'
import { describe, expect, it } from 'vitest'
import { KvActorCache, type KvNamespace } from './actor-cache-kv.js'

/** In-memory stand-in for the Workers KV slice the cache uses. */
function fakeKv() {
  const store = new Map<string, string>()
  const puts: Array<{ key: string; value: string; ttl?: number }> = []
  const kv: KvNamespace = {
    async get(k) {
      return store.get(k) ?? null
    },
    async put(k, v, opts) {
      store.set(k, v)
      puts.push({ key: k, value: v, ttl: opts?.expirationTtl })
    },
  }
  return { kv, puts }
}

const actor = {
  orgId: 'o1',
  principalId: 'p1',
  type: 'agent',
  role: 'member',
  scopes: [],
  clientInfo: null,
} as unknown as Actor

describe('KvActorCache', () => {
  it('returns undefined on a miss', async () => {
    const { kv } = fakeKv()
    expect(await new KvActorCache(kv).get('missing')).toBeUndefined()
  })

  it('round-trips an actor and floors the TTL to KV’s 60s minimum', async () => {
    const { kv, puts } = fakeKv()
    const cache = new KvActorCache(kv)
    await cache.set('k', actor, 1000) // 1s requested → floored to 60
    expect(puts[0]?.ttl).toBe(60)
    expect(await cache.get('k')).toEqual(actor)
  })

  it('rounds a longer TTL up to whole seconds', async () => {
    const { kv, puts } = fakeKv()
    await new KvActorCache(kv).set('k', actor, 120_500) // 120.5s → ceil 121
    expect(puts[0]?.ttl).toBe(121)
  })

  it('skips the write entirely when ttl <= 0', async () => {
    const { kv, puts } = fakeKv()
    await new KvActorCache(kv).set('k', actor, 0)
    expect(puts).toHaveLength(0)
  })
})
