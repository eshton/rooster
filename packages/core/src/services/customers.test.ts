import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import type { Role } from '@rooster/schema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../actor.js'
import { ForbiddenError, NotFoundError, ValidationError } from '../errors.js'
import { createServices, type Services } from './index.js'

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
  services = createServices(db.repositories)
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

describe('customer lifecycle stage (ROO-55)', () => {
  it('advances a customer through legal transitions', async () => {
    const { owner, customer } = await setup()
    expect(customer.lifecycleStage).toBe('lead')

    const prospect = await services.customers.changeLifecycleStage(owner, {
      customerId: customer.id,
      stage: 'prospect',
    })
    expect(prospect.lifecycleStage).toBe('prospect')

    const active = await services.customers.changeLifecycleStage(owner, {
      customerId: customer.id,
      stage: 'active',
    })
    expect(active.lifecycleStage).toBe('active')
  })

  it('rejects an illegal transition (lead → active skips prospect)', async () => {
    const { owner, customer } = await setup()
    await expect(
      services.customers.changeLifecycleStage(owner, { customerId: customer.id, stage: 'active' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a same-stage no-op', async () => {
    const { owner, customer } = await setup()
    await expect(
      services.customers.changeLifecycleStage(owner, { customerId: customer.id, stage: 'lead' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a missing customer', async () => {
    const { owner } = await setup()
    await expect(
      services.customers.changeLifecycleStage(owner, {
        customerId: '00000000-0000-4000-8000-000000000000',
        stage: 'prospect',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('gates on crm:write — a viewer cannot move the lifecycle', async () => {
    const { org, owner, customer } = await setup()
    const viewer = await makeUser(org.id, owner, 'viewer')
    await expect(
      services.customers.changeLifecycleStage(viewer, {
        customerId: customer.id,
        stage: 'prospect',
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('update_customer no longer moves the lifecycle stage (stripped from the patch)', async () => {
    const { owner, customer } = await setup()
    // lifecycleStage is not part of updateCustomerInput; zod strips it, so the
    // stage stays put even if a caller passes it.
    const updated = await services.customers.update(owner, customer.id, {
      name: 'Renamed',
      lifecycleStage: 'active',
    } as never)
    expect(updated.name).toBe('Renamed')
    expect(updated.lifecycleStage).toBe('lead') // unchanged
  })
})
