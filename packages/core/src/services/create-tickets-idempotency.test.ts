import { loadConfig } from '@rooster/config'
import { createDatabase, type Database, type Repositories } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InternalError } from '../errors.js'
import { createServices, type Services } from './index.js'

// ROO-54: a transient failure while binding a ticket's idempotency key used to
// leave a keyless orphan that DUPLICATED on retry. We simulate that failure and
// assert the fix — the orphan is compensated, and re-sending the same batch with
// the same keys creates no duplicates.

let db: Database
let services: Services
let failKey: string | null = null

beforeEach(async () => {
  db = await createDatabase(
    loadConfig({
      DATABASE_URL: 'file::memory:',
      ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    }),
    { migrate: true },
  )
  const real = db.repositories
  // Wrap the repos so `idempotency.record` throws (a "transient" infra error)
  // for a chosen key — as if the DB blipped right after the ticket was inserted.
  const wrapped: Repositories = {
    ...real,
    idempotency: {
      lookup: (orgId, key) => real.idempotency.lookup(orgId, key),
      record: async (orgId, key, ticketId) => {
        if (failKey && key === failKey) throw new Error('transient: connection reset by peer')
        return real.idempotency.record(orgId, key, ticketId)
      },
    },
  }
  services = createServices(wrapped)
})
afterEach(async () => {
  failKey = null
  await db.close()
})

async function setup() {
  const { org, founder } = await services.orgs.bootstrap({
    org: { slug: 'acme', name: 'Acme', enrollmentPolicy: 'token' },
    founder: { displayName: 'Ada', email: 'ada@acme.test', name: 'Ada', avatarUrl: null },
  })
  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })
  const team = await services.teams.create(owner, { key: 'BAT', name: 'Batch' })
  const project = await services.projects.create(owner, { teamId: team.id, key: 'BAT', name: 'P' })
  return { owner, project }
}

describe('create_tickets idempotency under transient bind failure (ROO-54)', () => {
  it('compensates a failed key-bind and never duplicates on retry', async () => {
    const { owner, project } = await setup()
    const batch = {
      tickets: [
        { projectId: project.id, title: 'first', idempotencyKey: 'k1' },
        { projectId: project.id, title: 'second', idempotencyKey: 'k2' },
      ],
    }

    // First attempt: binding k2 blows up (transient). The batch reports partial
    // progress and the second ticket's orphan row is compensated (deleted).
    failKey = 'k2'
    await expect(services.tickets.createMany(owner, batch)).rejects.toBeInstanceOf(InternalError)

    const afterFail = await services.tickets.list(owner, project.id)
    expect(afterFail.map((t) => t.title)).toEqual(['first']) // only the bound one survives

    // Retry the identical batch with the same keys; binding works now.
    failKey = null
    const retried = await services.tickets.createMany(owner, batch)
    expect(retried.map((t) => t.title)).toEqual(['first', 'second'])

    // The whole project has exactly two tickets — 'first' was deduped, not
    // duplicated, and 'second' was created exactly once.
    const all = await services.tickets.list(owner, project.id)
    expect(all.map((t) => t.title).sort()).toEqual(['first', 'second'])
  })

  it('a clean retry after a fully-successful batch is a no-op (dedupe)', async () => {
    const { owner, project } = await setup()
    const batch = {
      tickets: [
        { projectId: project.id, title: 'a', idempotencyKey: 'ka' },
        { projectId: project.id, title: 'b', idempotencyKey: 'kb' },
      ],
    }
    const first = await services.tickets.createMany(owner, batch)
    const again = await services.tickets.createMany(owner, batch)
    expect(again.map((t) => t.id)).toEqual(first.map((t) => t.id)) // same tickets, no new rows
    expect((await services.tickets.list(owner, project.id)).length).toBe(2)
  })
})
