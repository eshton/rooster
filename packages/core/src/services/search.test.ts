import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../actor.js'
import type { Embedder } from '../notify.js'
import { createServices, type Services } from './index.js'

// Synonym-aware fake embedder: distinct literals can share a dimension, so the
// vector arm can match text the FTS/keyword arm cannot (and vice versa).
const DIM: Record<string, number> = { gamma: 2, signin: 2, delta: 3 }
const fakeEmbedder: Embedder = {
  model: 'fake',
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(1536).fill(0)
      for (const w of t.toLowerCase().split(/\W+/)) if (w in DIM) v[DIM[w]] += 1
      v[1535] = 0.001
      return v
    })
  },
}

let db: Database
let services: Services

beforeEach(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
  db = await createDatabase(config, { migrate: true })
  services = createServices(db.repositories, { embedder: fakeEmbedder, ragOverfetch: 5 })
})
afterEach(async () => {
  await db.close()
})

async function bootstrap() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  const team = await services.teams.create(owner, { key: 'ROOST', name: 'Roost' })
  const project = await services.projects.create(owner, {
    teamId: team.id,
    key: 'ROOST',
    name: 'Henhouse',
  })
  return { org, owner, project }
}

async function makeUser(orgId: string, owner: Actor, role: Role): Promise<Actor> {
  const principal = await db.repositories.principals.create(orgId, {
    type: 'user',
    displayName: role,
  })
  await db.repositories.users.create({
    principalId: principal.id,
    email: `${role}-${principal.id}@acme.test`,
    name: role,
    avatarUrl: null,
  })
  await services.members.upsert(owner, { principalId: principal.id, teamId: null, role })
  return services.resolveActor({ orgId, principalId: principal.id })
}

describe('hybrid retrieval (ROO-37)', () => {
  it('fuses keyword + vector arms; a source in both arms ranks first', async () => {
    const { owner, project } = await bootstrap()
    // both arms: literal "gamma" (FTS) + pure dim-2 embedding
    const both = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma alpha',
    })
    // keyword-only strength diluted in the vector arm by an off-dimension term
    const kw = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma delta delta',
    })
    // vector-only: "signin" shares gamma's dimension but is not the literal token
    const vec = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'signin workflow',
    })

    const hits = await services.search.hybrid(owner, { query: 'gamma', limit: 10 })
    const ids = hits.map((h) => h.sourceId)

    expect(hits[0]?.sourceId).toBe(both.id) // top of both arms
    expect(ids).toContain(vec.id) // vector arm surfaced a non-keyword match
    expect(ids).toContain(kw.id)
    expect(hits.every((h) => h.sourceType === 'ticket')).toBe(true)
  })

  it('degrades to keyword-only when no embedder is configured', async () => {
    const { org, owner, project } = await bootstrap()
    await services.tickets.create(owner, { projectId: project.id, title: 'gamma alpha' })
    const vec = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'signin workflow',
    })

    const noEmbed = createServices(db.repositories, {}) // same db, no embedder
    const ownerNoEmbed = await noEmbed.resolveActor({
      orgId: org.id,
      principalId: owner.principalId,
    })
    const hits = await noEmbed.search.hybrid(ownerNoEmbed, { query: 'gamma', limit: 10 })

    // Only the FTS match; the vector-only source is absent.
    expect(hits.map((h) => h.sourceId)).not.toContain(vec.id)
    expect(hits.length).toBeGreaterThan(0)
  })

  it('excludes gated sources (context files) for an actor without conversation:read', async () => {
    const { org, owner, project } = await bootstrap()
    await services.contextFiles.save(owner, {
      projectId: project.id,
      name: 'gamma notes',
      body: 'gamma gamma gamma',
    })
    const viewer = await makeUser(org.id, owner, 'viewer')

    const asOwner = await services.search.hybrid(owner, { query: 'gamma', limit: 10 })
    const asViewer = await services.search.hybrid(viewer, { query: 'gamma', limit: 10 })

    expect(asOwner.some((h) => h.sourceType === 'context_file')).toBe(true)
    expect(asViewer.some((h) => h.sourceType === 'context_file')).toBe(false)
  })
})

describe('rag_search — grounded retrieval (ROO-38)', () => {
  it('resolves fused hits to cited results and builds a context block', async () => {
    const { owner, project } = await bootstrap()
    const t = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma protocol',
      description: 'the gamma handshake spec',
    })

    const res = await services.search.rag(owner, { query: 'gamma', limit: 5 })

    expect(res.hits.length).toBeGreaterThan(0)
    const hit = res.hits.find((h) => h.sourceKey === t.key)
    expect(hit).toBeDefined()
    expect(hit?.sourceType).toBe('ticket')
    expect(hit?.projectKey).toBe('ROOST')
    expect(hit?.ticketId).toBe(t.id)
    expect(hit?.snippet).toContain('gamma')
    // The context block cites the source key and carries the snippet.
    expect(res.contextBlock).toContain(t.key)
    expect(res.contextBlock).toContain('gamma')
  })

  it('honors the ticketId filter (only that ticket’s sources)', async () => {
    const { owner, project } = await bootstrap()
    const keep = await services.tickets.create(owner, { projectId: project.id, title: 'gamma one' })
    await services.tickets.create(owner, { projectId: project.id, title: 'gamma two' })

    const res = await services.search.rag(owner, { query: 'gamma', ticketId: keep.id, limit: 10 })
    expect(res.hits.map((h) => h.ticketId)).toEqual([keep.id])
  })

  it('honors the projectId filter', async () => {
    const { org, owner, project } = await bootstrap()
    await services.tickets.create(owner, { projectId: project.id, title: 'gamma here' })
    // A second project whose tickets must be excluded.
    const team2 = await services.teams.create(owner, { key: 'OTHER', name: 'Other' })
    const project2 = await services.projects.create(owner, {
      teamId: team2.id,
      key: 'OTHER',
      name: 'Other',
    })
    await services.tickets.create(owner, { projectId: project2.id, title: 'gamma elsewhere' })

    const res = await services.search.rag(owner, {
      query: 'gamma',
      projectId: project.id,
      limit: 10,
    })
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.hits.every((h) => h.projectKey === 'ROOST')).toBe(true)
    // sanity: the org actually had a matching ticket in the other project
    expect(org.id).toBeDefined()
  })

  it('applies a reranker to re-order results, and falls back to fusion order without one', async () => {
    // Reranker promotes any candidate whose snippet carries the marker.
    const reranker = {
      model: 'fake-rerank',
      async rerank(_q: string, docs: string[]) {
        return docs.map((d) => (d.includes('PRIORITYMARK') ? 1 : 0))
      },
    }
    const svc = createServices(db.repositories, {
      embedder: fakeEmbedder,
      ragOverfetch: 5,
      reranker,
    })
    const { org, founder } = await svc.orgs.bootstrap({
      org: { slug: 'rrk', name: 'Rrk', enrollmentPolicy: 'token' },
      founder: { displayName: 'Ada', email: 'ada@rrk.test', name: 'Ada', avatarUrl: null },
    })
    const owner = await svc.resolveActor({ orgId: org.id, principalId: founder.id })
    const team = await svc.teams.create(owner, { key: 'RRK', name: 'Rrk' })
    const project = await svc.projects.create(owner, { teamId: team.id, key: 'RRK', name: 'P' })

    // Query on two terms ("gamma delta"). `dominant` matches BOTH — so it
    // strictly out-scores the others in both arms (extra vector dimension +
    // extra keyword term) and is the unambiguous fusion winner. The single-term
    // docs only match "gamma". The marked ticket also carries the PRIORITYMARK
    // token the reranker keys on. Nothing ties at the top, which is what makes
    // this deterministic (the old single-term corpus tied on "gamma" and made
    // the "not first" assertion flaky — ROO-56).
    const dominant = await svc.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma delta alpha',
    })
    await svc.tickets.create(owner, { projectId: project.id, title: 'gamma beta' })
    const marked = await svc.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma PRIORITYMARK zed',
    })

    const reranked = await svc.search.rag(owner, { query: 'gamma delta', limit: 3 })
    expect(reranked.hits[0]?.sourceKey).toBe(marked.key) // reranker promoted it to the top

    // Same corpus, no reranker → fusion order, where `dominant` (matches both
    // query terms) deterministically wins and the marked ticket is not first.
    const noRerank = createServices(db.repositories, { embedder: fakeEmbedder, ragOverfetch: 5 })
    const ownerNo = await noRerank.resolveActor({ orgId: org.id, principalId: owner.principalId })
    const fused = await noRerank.search.rag(ownerNo, { query: 'gamma delta', limit: 3 })
    expect(fused.hits[0]?.sourceKey).toBe(dominant.key)
    expect(fused.hits[0]?.sourceKey).not.toBe(marked.key)
  })

  it('keeps fusion order when the reranker fails (best-effort)', async () => {
    const reranker = {
      model: 'boom',
      async rerank() {
        throw new Error('rerank provider down')
      },
    }
    const svc = createServices(db.repositories, {
      embedder: fakeEmbedder,
      ragOverfetch: 5,
      reranker,
    })
    const { org, founder } = await svc.orgs.bootstrap({
      org: { slug: 'brk', name: 'Brk', enrollmentPolicy: 'token' },
      founder: { displayName: 'Ada', email: 'ada@brk.test', name: 'Ada', avatarUrl: null },
    })
    const owner = await svc.resolveActor({ orgId: org.id, principalId: founder.id })
    const team = await svc.teams.create(owner, { key: 'BRK', name: 'Brk' })
    const project = await svc.projects.create(owner, { teamId: team.id, key: 'BRK', name: 'P' })
    await svc.tickets.create(owner, { projectId: project.id, title: 'gamma one' })
    await svc.tickets.create(owner, { projectId: project.id, title: 'gamma two' })

    const res = await svc.search.rag(owner, { query: 'gamma', limit: 3 })
    expect(res.hits.length).toBeGreaterThan(0) // did not throw

    // Falls back to exactly the fusion order (same corpus, no reranker).
    const noRerank = createServices(db.repositories, { embedder: fakeEmbedder, ragOverfetch: 5 })
    const ownerNo = await noRerank.resolveActor({ orgId: org.id, principalId: owner.principalId })
    const fused = await noRerank.search.rag(ownerNo, { query: 'gamma', limit: 3 })
    expect(res.hits.map((h) => h.sourceKey)).toEqual(fused.hits.map((h) => h.sourceKey))
  })

  it('quotes the matched passage, not the document head (ROO-40)', async () => {
    // Small chunks so a modest body splits; "delta" lives only in a later chunk.
    const svc = createServices(db.repositories, {
      embedder: fakeEmbedder,
      ragOverfetch: 5,
      chunkConfig: { size: 50, overlap: 10 },
    })
    const { org, founder } = await svc.orgs.bootstrap({
      org: { slug: 'psg', name: 'Psg', enrollmentPolicy: 'token' },
      founder: { displayName: 'Ada', email: 'ada@psg.test', name: 'Ada', avatarUrl: null },
    })
    const owner = await svc.resolveActor({ orgId: org.id, principalId: founder.id })
    const team = await svc.teams.create(owner, { key: 'PSG', name: 'Psg' })
    const project = await svc.projects.create(owner, { teamId: team.id, key: 'PSG', name: 'P' })

    await svc.contextFiles.save(owner, {
      projectId: project.id,
      name: 'notes',
      body: `${'zzz '.repeat(30)}the delta signal lives here`,
    })

    const res = await svc.search.rag(owner, { query: 'delta', limit: 5 })
    const hit = res.hits.find((h) => h.sourceType === 'context_file')
    expect(hit).toBeDefined()
    // Passage-accurate: quotes the "delta" region from deep in the doc, not the head.
    expect(hit?.snippet).toContain('delta')
    expect(hit?.chunk?.start).toBeGreaterThan(0)
  })
})

describe('find_similar_tickets project scoping (ROO-69)', () => {
  it('scopes to one project when projectId is set, else spans the org', async () => {
    const { org, owner } = await bootstrap()
    // A second project in the same org, both with a "gamma" ticket.
    const teamB = await services.teams.create(owner, { key: 'OTH', name: 'Other' })
    const projectB = await services.projects.create(owner, {
      teamId: teamB.id,
      key: 'OTH',
      name: 'Other',
    })
    // bootstrap()'s project is ROOST; reuse it for project A.
    const projects = await services.projects.list(owner)
    const projectA = projects.find((p) => p.key === 'ROOST')
    if (!projectA) throw new Error('missing project A')

    const a = await services.tickets.create(owner, { projectId: projectA.id, title: 'gamma alpha' })
    const b = await services.tickets.create(owner, { projectId: projectB.id, title: 'gamma beta' })

    // Org-wide: both projects' gamma tickets surface.
    const orgWide = await services.tickets.findSimilar(owner, 'gamma', 10)
    const orgIds = orgWide.map((t) => t.id)
    expect(orgIds).toContain(a.id)
    expect(orgIds).toContain(b.id)

    // Scoped to project A: only A's ticket, never B's.
    const scoped = await services.tickets.findSimilar(owner, 'gamma', 10, projectA.id)
    expect(scoped.map((t) => t.id)).toContain(a.id)
    expect(scoped.every((t) => t.projectId === projectA.id)).toBe(true)
    expect(scoped.map((t) => t.id)).not.toContain(b.id)
    expect(org.id).toBeDefined()
  })
})
