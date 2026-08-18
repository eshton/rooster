import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { embedAndStore } from './embed.js'
import type { Embedder } from './notify.js'

// Deterministic bag-of-words embedder over a tiny vocab (dims 1536, the default).
// A query aligns with a chunk on the vocab dimension its word occupies.
const VOCAB = ['alpha', 'beta', 'gamma', 'delta']
const fakeEmbedder: Embedder = {
  model: 'fake',
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(1536).fill(0)
      const low = t.toLowerCase()
      VOCAB.forEach((w, i) => {
        v[i] = low.split(w).length - 1
      })
      v[1535] = 0.001 // tiny base signal so an all-miss vector isn't a zero vector
      return v
    })
  },
}
const CHUNK = { size: 40, overlap: 10 }

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

describe('embedAndStore (chunk-aware embeddings, ROO-36)', () => {
  it('chunks a long source, stores many chunks, and search dedupes to one hit per source', async () => {
    const org = await db.repositories.orgs.create({
      slug: 'acme',
      name: 'Acme',
      enrollmentPolicy: 'token',
    })
    const e = db.repositories.embeddings

    // ~180 chars → several 40-char chunks, each containing "gamma".
    const gammaDoc = 'gamma '.repeat(30).trim()
    const deltaDoc = 'delta '.repeat(30).trim()
    await embedAndStore(db.repositories, fakeEmbedder, CHUNK, org.id, 'context_file', [
      { id: 'cf-gamma', text: gammaDoc },
      { id: 'cf-delta', text: deltaDoc },
    ])

    // Both sources are indexed.
    expect(
      (await e.existingFor(org.id, 'context_file', ['cf-gamma', 'cf-delta', 'cf-none'])).sort(),
    ).toEqual(['cf-delta', 'cf-gamma'])

    const [queryVec] = await fakeEmbedder.embed(['gamma'])
    const hits = await e.search(org.id, 'context_file', queryVec, 50)

    // The gamma doc ranks first despite being spread over many chunks...
    expect(hits[0]?.sourceId).toBe('cf-gamma')
    // ...and appears exactly once — chunks are collapsed to the best per source.
    expect(hits.filter((h) => h.sourceId === 'cf-gamma')).toHaveLength(1)
    expect(hits.filter((h) => h.sourceId === 'cf-delta')).toHaveLength(1)
  })

  it('re-embedding replaces a source’s chunks (no stale chunks linger)', async () => {
    const org = await db.repositories.orgs.create({
      slug: 'acme',
      name: 'Acme',
      enrollmentPolicy: 'token',
    })
    const e = db.repositories.embeddings

    await embedAndStore(db.repositories, fakeEmbedder, CHUNK, org.id, 'ticket', [
      { id: 't1', text: 'gamma '.repeat(30).trim() },
    ])
    // Re-embed the same source with different, shorter content.
    await embedAndStore(db.repositories, fakeEmbedder, CHUNK, org.id, 'ticket', [
      { id: 't1', text: 'delta' },
    ])

    // Now t1 matches delta, not gamma (old chunks were replaced, not appended).
    const [gammaQ] = await fakeEmbedder.embed(['gamma'])
    const [deltaQ] = await fakeEmbedder.embed(['delta'])
    const gammaHit = (await e.search(org.id, 'ticket', gammaQ, 50)).find((h) => h.sourceId === 't1')
    const deltaHit = (await e.search(org.id, 'ticket', deltaQ, 50)).find((h) => h.sourceId === 't1')
    expect(deltaHit).toBeDefined()
    expect(deltaHit?.distance).toBeLessThan(gammaHit?.distance ?? 1)
  })

  it('is a no-op without an embedder or with empty text', async () => {
    const org = await db.repositories.orgs.create({
      slug: 'acme',
      name: 'Acme',
      enrollmentPolicy: 'token',
    })
    await embedAndStore(db.repositories, undefined, CHUNK, org.id, 'ticket', [
      { id: 't1', text: 'x' },
    ])
    await embedAndStore(db.repositories, fakeEmbedder, CHUNK, org.id, 'ticket', [
      { id: 't2', text: '   ' },
    ])
    expect(await db.repositories.embeddings.existingFor(org.id, 'ticket', ['t1', 't2'])).toEqual([])
  })
})
