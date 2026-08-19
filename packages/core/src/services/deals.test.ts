import { loadConfig } from '@rooster/config'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { canDealTransition } from '../deal-transitions.js'
import { NotFoundError, ValidationError } from '../errors.js'
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

async function setup() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  const customer = await services.customers.create(owner, { name: 'Acme Co' })
  return { org, owner, customer }
}

describe('deal-transitions', () => {
  it('allows the pipeline path and rejects skips', () => {
    expect(canDealTransition('prospecting', 'qualified')).toBe(true)
    expect(canDealTransition('proposal', 'won')).toBe(true)
    expect(canDealTransition('won', 'proposal')).toBe(true) // reopen
    expect(canDealTransition('prospecting', 'won')).toBe(false) // skip
    expect(canDealTransition('lost', 'won')).toBe(false)
  })
})

describe('CRM deals (ROO-48)', () => {
  it('opens a deal under a customer with the default stage', async () => {
    const { owner, customer } = await setup()
    const deal = await services.deals.create(owner, {
      customerId: customer.id,
      title: 'Hosting renewal',
      value: 799000,
      currency: 'HUF',
    })
    expect(deal.pipelineStage).toBe('prospecting')
    expect(deal.value).toBe(799000)
    expect(deal.currency).toBe('HUF')
    expect((await services.deals.list(owner, customer.id)).map((d) => d.id)).toEqual([deal.id])
  })

  it('rejects a deal for a missing customer', async () => {
    const { owner } = await setup()
    await expect(
      services.deals.create(owner, {
        customerId: '00000000-0000-4000-8000-000000000000',
        title: 'ghost',
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('advances the pipeline and rejects illegal / no-op transitions', async () => {
    const { owner, customer } = await setup()
    const deal = await services.deals.create(owner, { customerId: customer.id, title: 'Sale' })

    const q = await services.deals.changeStage(owner, { dealId: deal.id, stage: 'qualified' })
    expect(q.pipelineStage).toBe('qualified')

    // skip qualified→won is illegal
    await expect(
      services.deals.changeStage(owner, { dealId: deal.id, stage: 'won' }),
    ).rejects.toBeInstanceOf(ValidationError)

    // same-stage no-op is rejected
    await expect(
      services.deals.changeStage(owner, { dealId: deal.id, stage: 'qualified' }),
    ).rejects.toBeInstanceOf(ValidationError)

    // legal path to won
    await services.deals.changeStage(owner, { dealId: deal.id, stage: 'proposal' })
    const won = await services.deals.changeStage(owner, { dealId: deal.id, stage: 'won' })
    expect(won.pipelineStage).toBe('won')
  })

  it('updates fields and writes audit; a stage change is audited too', async () => {
    const { owner, customer } = await setup()
    const deal = await services.deals.create(owner, { customerId: customer.id, title: 'x' })
    const up = await services.deals.update(owner, deal.id, { probability: 60, tags: ['warm'] })
    expect(up.probability).toBe(60)
    expect(up.tags).toEqual(['warm'])

    await services.deals.changeStage(owner, { dealId: deal.id, stage: 'qualified' })
    const audits = await services.audit.list(owner, {})
    expect(audits.some((a) => a.action === 'deal.change_stage' && a.targetId === deal.id)).toBe(
      true,
    )
  })

  it('isolates deals per org', async () => {
    const a = await setup()
    const deal = await services.deals.create(a.owner, { customerId: a.customer.id, title: 'A' })
    const b = await services.orgs.bootstrap({
      org: { slug: 'other', name: 'Other', enrollmentPolicy: 'open' },
      founder: { displayName: 'Bo', email: 'bo@other.test', name: 'Bo', avatarUrl: null },
    })
    const ownerB = await services.resolveActor({ orgId: b.org.id, principalId: b.founder.id })
    await expect(services.deals.get(ownerB, deal.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
