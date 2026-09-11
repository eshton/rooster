import { loadConfig } from '@rooster/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { embedderFor } from './embedder-http.js'

const base = {
  DATABASE_URL: 'file::memory:',
  ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  ROOSTER_BASE_URL: 'http://localhost:3000',
}

// text-embedding-3-small → 1536 dims (the default embeddingDims).
const DIMS = 1536
const vec = (fill: number) => new Array<number>(DIMS).fill(fill)
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

const withKey = {
  ...base,
  ROOSTER_EMBEDDING_URL: 'https://api.openai.com/v1/embeddings',
  ROOSTER_EMBEDDING_API_KEY: 'sk-test',
}
const keyless = {
  ...base,
  ROOSTER_EMBEDDING_URL: 'http://ollama:11434/v1/embeddings',
  ROOSTER_EMBEDDING_MODEL: 'text-embedding-3-small', // keep 1536 dims for the test
}

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('embedderFor', () => {
  it('is undefined when no embedder is configured', () => {
    expect(embedderFor(loadConfig(base))).toBeUndefined()
  })

  it('is undefined on the Postgres path (no native vectors)', () => {
    const cfg = loadConfig({ ...withKey, DATABASE_URL: 'postgres://u:p@h:5432/db' })
    expect(embedderFor(cfg)).toBeUndefined()
  })

  it('embeds text and returns vectors ordered by index', async () => {
    const data = [{ embedding: vec(2), index: 1 }, { embedding: vec(1), index: 0 }]
    stubFetch(() => json({ data }))
    const embedder = embedderFor(loadConfig(withKey))
    const out = await embedder?.embed(['a', 'b'])
    expect(out?.[0]?.[0]).toBe(1) // index 0 first
    expect(out?.[1]?.[0]).toBe(2)
  })

  it('sends an Authorization header only when a key is configured', async () => {
    const fn = stubFetch(() => json({ data: [{ embedding: vec(1), index: 0 }] }))
    await embedderFor(loadConfig(keyless))?.embed(['x'])
    const headers = (fn.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBeUndefined()

    fn.mockClear()
    await embedderFor(loadConfig(withKey))?.embed(['x'])
    const authed = (fn.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(authed.authorization).toBe('Bearer sk-test')
  })

  it('returns [] for empty input without calling fetch', async () => {
    const fn = stubFetch(() => json({}))
    expect(await embedderFor(loadConfig(withKey))?.embed([])).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response', async () => {
    stubFetch(() => new Response('bad', { status: 429 }))
    await expect(embedderFor(loadConfig(withKey))?.embed(['x'])).rejects.toThrow(/failed \(429\)/)
  })

  it('throws when a returned vector has the wrong dimension', async () => {
    stubFetch(() => json({ data: [{ embedding: [1, 2, 3], index: 0 }] }))
    const embedder = embedderFor(loadConfig(withKey))
    await expect(embedder?.embed(['x'])).rejects.toThrow(/dims; expected 1536/)
  })
})
