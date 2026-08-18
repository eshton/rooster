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
