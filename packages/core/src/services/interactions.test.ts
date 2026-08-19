import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../actor.js'
import { ForbiddenError, NotFoundError } from '../errors.js'
import type { Embedder } from '../notify.js'
import { createServices, type Services } from './index.js'

// Bag-of-words fake embedder over a tiny vocab (dims 1536, the default).
const VOCAB = ['alpha', 'gamma', 'delta']
const fakeEmbedder: Embedder = {
  model: 'fake',
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(1536).fill(0)
      const low = t.toLowerCase()
      VOCAB.forEach((w, i) => {
        v[i] = low.split(w).length - 1
      })
      v[1535] = 0.001
      return v
    })
  },
}

let db: Database
let services: Services

beforeEach(async () => {
  db = await createDatabase(
    loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    }),
    { migrate: true },
  )
  services = createServices(db.repositories, { embedder: fakeEmbedder })
})
afterEach(async () => {
  await db.close()
})

async function setup() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  const customer = await services.customers.create(owner, { name: 'Villanyozzunk' })
  return { org, owner, customer }
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

describe('CRM interactions (ROO-49)', () => {
  it('logs and lists interactions against a customer', async () => {
    const { owner, customer } = await setup()
    const i = await services.interactions.log(owner, {
      targetType: 'customer',
      targetId: customer.id,
      kind: 'call',
      body: 'Discussed the gamma hosting renewal and agreed on the price.',
    })
    expect(i.authorId).toBe(owner.principalId)
    expect(i.occurredAt).toBeTruthy()

    const list = await services.interactions.list(owner, {
      targetType: 'customer',
      targetId: customer.id,
    })
    expect(list.map((x) => x.id)).toEqual([i.id])
  })

  it('rejects an interaction for a missing target', async () => {
    const { owner } = await setup()
    await expect(
      services.interactions.log(owner, {
        targetType: 'deal',
        targetId: '00000000-0000-4000-8000-000000000000',
        kind: 'note',
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('gates on crm scope — a viewer cannot log or list', async () => {
    const { org, owner, customer } = await setup()
    const viewer = await makeUser(org.id, owner, 'viewer')
    await expect(
      services.interactions.log(viewer, {
        targetType: 'customer',
        targetId: customer.id,
        kind: 'note',
        body: 'x',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      services.interactions.list(viewer, { targetType: 'customer', targetId: customer.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('surfaces a logged interaction in rag_search with a cited snippet', async () => {
    const { owner, customer } = await setup()
    await services.interactions.log(owner, {
      targetType: 'customer',
      targetId: customer.id,
      kind: 'meeting',
      body: 'The gamma agreement covers monthly updates and support.',
    })

    const res = await services.search.rag(owner, {
      query: 'gamma agreement support',
      sourceTypes: ['interaction'],
      limit: 5,
    })
    expect(res.hits.length).toBeGreaterThan(0)
    const hit = res.hits[0]
    expect(hit.sourceType).toBe('interaction')
    expect(hit.sourceKey).toContain('Villanyozzunk') // resolved to the customer
    expect(hit.snippet).toContain('gamma')
    expect(res.contextBlock).toContain('gamma')
  })

  it('hides interactions from a viewer without crm:read in rag_search', async () => {
    const { org, owner, customer } = await setup()
    await services.interactions.log(owner, {
      targetType: 'customer',
      targetId: customer.id,
      kind: 'note',
      body: 'gamma secret pricing note',
    })
    const viewer = await makeUser(org.id, owner, 'viewer')
    const res = await services.search.rag(viewer, { query: 'gamma', limit: 5 })
    expect(res.hits.some((h) => h.sourceType === 'interaction')).toBe(false)
  })
})
