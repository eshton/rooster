import { loadConfig } from '@rooster/config'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rerankerFor } from './reranker-http.js'

const base = {
  DATABASE_URL: 'file::memory:',
  ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  ROOSTER_BASE_URL: 'http://localhost:3000',
}

const withRerank = {
  ...base,
  ROOSTER_RERANK_URL: 'https://api.example.com/rerank',
  ROOSTER_RERANK_API_KEY: 'rk-test',
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const fn = vi.fn(async (url: string, init: RequestInit) => impl(url, init))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('rerankerFor', () => {
  it('is undefined when no reranker is configured', () => {
    expect(rerankerFor(loadConfig(base))).toBeUndefined()
  })

  it('maps ranked {id,score} back to per-document scores by index', async () => {
    stubFetch(() =>
      json({
        result: {
          response: [
            { id: 1, score: 0.9 },
            { id: 0, score: 0.2 },
          ],
        },
      }),
    )
    const reranker = rerankerFor(loadConfig(withRerank))
    const scores = await reranker?.rerank('q', ['doc-a', 'doc-b'])
    expect(scores).toEqual([0.2, 0.9])
  })

  it('accepts the alternate top-level response shape', async () => {
    stubFetch(() => json({ response: [{ id: 0, score: 0.5 }] }))
    const reranker = rerankerFor(loadConfig(withRerank))
    expect(await reranker?.rerank('q', ['only'])).toEqual([0.5])
  })

  it('short-circuits on empty documents without calling fetch', async () => {
    const fn = stubFetch(() => json({}))
    const reranker = rerankerFor(loadConfig(withRerank))
    expect(await reranker?.rerank('q', [])).toEqual([])
    expect(fn).not.toHaveBeenCalled()
  })

  it('throws on a non-ok response', async () => {
    stubFetch(() => new Response('nope', { status: 500 }))
    const reranker = rerankerFor(loadConfig(withRerank))
    await expect(reranker?.rerank('q', ['d'])).rejects.toThrow(/Rerank request failed \(500\)/)
  })

  it('throws when the response shape has no ranking', async () => {
    stubFetch(() => json({ nonsense: true }))
    const reranker = rerankerFor(loadConfig(withRerank))
    await expect(reranker?.rerank('q', ['d'])).rejects.toThrow(/shape unexpected/)
  })
})
