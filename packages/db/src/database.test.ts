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
  it('reports the selected driver while the impl is pending (phase 2)', async () => {
    await expect(createDatabase(configFor('file:./local.db'))).rejects.toThrow(
      /not yet implemented \(phase 2\)/,
    )
  })
})
