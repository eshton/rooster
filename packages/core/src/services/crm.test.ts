import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../actor.js'
import { ForbiddenError, NotFoundError } from '../errors.js'
import { createServices, type Services } from './index.js'

let db: Database
let services: Services

beforeEach(async () => {
  const config = loadConfig({
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
  db = await createDatabase(config, { migrate: true })
  services = createServices(db.repositories)
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
  return { org, owner }
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

describe('CRM: customers + contacts (ROO-47)', () => {
  it('creates, reads, lists and updates a customer', async () => {
    const { owner } = await bootstrap()
    const created = await services.customers.create(owner, { name: 'Villanyozzunk Kft' })
    expect(created.lifecycleStage).toBe('lead') // default
    expect(created.tags).toEqual([])

    expect((await services.customers.get(owner, created.id)).name).toBe('Villanyozzunk Kft')
    expect((await services.customers.list(owner)).map((c) => c.id)).toEqual([created.id])

    const updated = await services.customers.update(owner, created.id, {
      tags: ['hosting', 'vip'],
    })
    expect(updated.tags).toEqual(['hosting', 'vip'])
    expect(updated.lifecycleStage).toBe('lead') // update doesn't touch the lifecycle

    // Lifecycle moves through the validated transition (ROO-55), not update.
    const advanced = await services.customers.changeLifecycleStage(owner, {
      customerId: created.id,
      stage: 'prospect',
    })
    expect(advanced.lifecycleStage).toBe('prospect')
  })

  it('adds/lists/updates/removes contacts under a customer', async () => {
    const { owner } = await bootstrap()
    const customer = await services.customers.create(owner, { name: 'Acme Co' })

    const c = await services.contacts.add(owner, {
      customerId: customer.id,
      name: 'Béla',
      email: 'bela@acme.co',
      role: 'Owner',
    })
    expect(c.email).toBe('bela@acme.co')
    expect((await services.contacts.list(owner, customer.id)).map((x) => x.id)).toEqual([c.id])

    const up = await services.contacts.update(owner, c.id, { phone: '+3612345678' })
    expect(up.phone).toBe('+3612345678')

    expect(await services.contacts.remove(owner, c.id)).toEqual({ removed: true })
    expect(await services.contacts.list(owner, customer.id)).toEqual([])
  })

  it('rejects a contact for a missing customer', async () => {
    const { owner } = await bootstrap()
    await expect(
      services.contacts.add(owner, {
        customerId: '00000000-0000-4000-8000-000000000000',
        name: 'Ghost',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('writes an audit record on customer.create', async () => {
    const { owner } = await bootstrap()
    const customer = await services.customers.create(owner, { name: 'Audited' })
    const audits = await services.audit.list(owner, {})
    expect(audits.some((a) => a.action === 'customer.create' && a.targetId === customer.id)).toBe(
      true,
    )
  })

  it('gates on crm scope/role — a viewer can neither read nor write', async () => {
    const { org, owner } = await bootstrap()
    const customer = await services.customers.create(owner, { name: 'Secret Co' })
    const viewer = await makeUser(org.id, owner, 'viewer')

    await expect(services.customers.list(viewer)).rejects.toBeInstanceOf(ForbiddenError)
    await expect(services.customers.create(viewer, { name: 'nope' })).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(services.customers.get(viewer, customer.id)).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('isolates customers per org', async () => {
    const a = await bootstrap()
    const custA = await services.customers.create(a.owner, { name: 'Org A customer' })

    const b = await services.orgs.bootstrap({
      org: { slug: 'other', name: 'Other', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@other.test', name: 'Bo', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({ orgId: b.org.id, principalId: b.founder.id })

    expect(await services.customers.list(ownerB)).toEqual([])
    await expect(services.customers.get(ownerB, custA.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
