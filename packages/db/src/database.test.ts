import { loadConfig } from '@rooster/config'
import { describe, expect, it } from 'vitest'
import { createDatabase, describeDriver } from './index.js'

function configFor(databaseUrl: string) {
  return loadConfig({
    DATABASE_URL: databaseUrl,
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  })
}

describe('describeDriver', () => {
  it('routes a postgres URL to the pg driver', () => {
    const plan = describeDriver(configFor('postgres://u:p@h:5432/db'))
    expect(plan.kind).toBe('postgres')
    expect(plan.driverPackage).toBe('pg')
  })

  it('routes a file URL to the libsql client', () => {
    const plan = describeDriver(configFor('file:./local.db'))
    expect(plan.kind).toBe('sqlite')
    expect(plan.driverPackage).toBe('@libsql/client')
  })

  it('routes a libsql URL to the libsql client', () => {
    const plan = describeDriver(configFor('libsql://x.turso.io'))
    expect(plan.kind).toBe('libsql')
    expect(plan.driverPackage).toBe('@libsql/client')
  })
})

describe('createDatabase', () => {
  it('opens, migrates and closes an in-memory SQLite database', async () => {
    const db = await createDatabase(configFor('file::memory:'), { migrate: true })
    expect(db.kind).toBe('sqlite')
    const org = await db.repositories.orgs.create({
      slug: 'smoke',
      name: 'Smoke',
      enrollmentPolicy: 'open',
    })
    expect(org.id).toMatch(/[0-9a-f-]{36}/)
    await db.close()
  })
})
