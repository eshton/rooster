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
  const deal = await services.deals.create(owner, {
    customerId: customer.id,
    title: 'Website build',
  })
  const team = await services.teams.create(owner, { key: 'DLV', name: 'Delivery' })
  const project = await services.projects.create(owner, {
    teamId: team.id,
    key: 'WEB',
    name: 'Client website',
  })
  return { org, owner, customer, deal, project }
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

describe('CRM won-deal → delivery-work bridge (ROO-50)', () => {
  it('links a project to a deal and derives the customer', async () => {
    const { owner, customer, deal, project } = await setup()
    const linked = await services.deals.linkWork(owner, { dealId: deal.id, projectId: project.id })
    expect(linked.dealId).toBe(deal.id)
    expect(linked.customerId).toBe(customer.id)

    const dealWork = await services.deals.listWork(owner, { dealId: deal.id })
    expect(dealWork.map((p) => p.id)).toEqual([project.id])
  })

  it('surfaces deal-linked work in the customer aggregate view', async () => {
    const { owner, customer, deal, project } = await setup()
    await services.deals.linkWork(owner, { dealId: deal.id, projectId: project.id })

    const customerWork = await services.customers.listWork(owner, { customerId: customer.id })
    expect(customerWork.map((p) => p.id)).toEqual([project.id])
  })

  it('rejects linking a missing project or deal', async () => {
    const { owner, deal, project } = await setup()
    const missing = '00000000-0000-4000-8000-000000000000'
    await expect(
      services.deals.linkWork(owner, { dealId: deal.id, projectId: missing }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      services.deals.linkWork(owner, { dealId: missing, projectId: project.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('gates linking on crm:write', async () => {
    const { org, owner, deal, project } = await setup()
    const viewer = await makeUser(org.id, owner, 'viewer')
    await expect(
      services.deals.linkWork(viewer, { dealId: deal.id, projectId: project.id }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})
