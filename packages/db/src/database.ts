import type { DbKind, RoosterConfig } from '@rooster/config'
import { createLibsqlDatabase } from './drivers/libsql.js'
import { createPostgresDatabase } from './drivers/postgres.js'
import type { Repositories } from './repositories.js'

/** A connected database handle: the chosen driver plus its repositories. */
export interface Database {
  readonly kind: DbKind
  readonly repositories: Repositories
  close(): Promise<void>
}

export interface CreateDatabaseOptions {
  /** Apply pending migrations on the same connection before returning. */
  migrate?: boolean
}

/** Static description of the driver a given config will use. */
export interface DriverPlan {
  kind: DbKind
  /** The npm package the driver implementation depends on. */
  driverPackage: string
  /** Human-readable label for logs / diagnostics. */
  label: string
}

const PLANS: Record<DbKind, Omit<DriverPlan, 'kind'>> = {
  postgres: { driverPackage: 'pg', label: 'PostgreSQL (node-postgres)' },
  sqlite: { driverPackage: '@libsql/client', label: 'SQLite (libSQL, local file)' },
  libsql: { driverPackage: '@libsql/client', label: 'libSQL / Turso (remote)' },
}

/**
 * Pure description of which driver a config selects — no connection is opened.
 * Useful for startup logging and for asserting the DATABASE_URL routing.
 */
export function describeDriver(config: Pick<RoosterConfig, 'database'>): DriverPlan {
  return { kind: config.database.kind, ...PLANS[config.database.kind] }
}

/**
 * Open a database connection and return its repositories. The concrete driver
 * is selected purely from the resolved `DATABASE_URL` scheme.
 */
export function createDatabase(
  config: RoosterConfig,
  opts: CreateDatabaseOptions = {},
): Promise<Database> {
  switch (config.database.kind) {
    case 'sqlite':
    case 'libsql':
      return createLibsqlDatabase(config, opts)
    case 'postgres':
      return createPostgresDatabase(config, opts)
  }
}
