import type { DbKind, RoosterConfig } from '@rooster/config'
import type { Repositories } from './repositories.js'

/** A connected database handle: the chosen driver plus its repositories. */
export interface Database {
  readonly kind: DbKind
  readonly repositories: Repositories
  close(): Promise<void>
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
 * Open a database connection and return its repositories.
 *
 * NOTE: the concrete Drizzle-backed drivers are implemented in phase 2 (data
 * layer). The contract and driver selection are defined here so the core
 * service layer can be built against `Database`/`Repositories` today.
 */
export async function createDatabase(config: RoosterConfig): Promise<Database> {
  const plan = describeDriver(config)
  throw new Error(
    `createDatabase: ${plan.label} driver not yet implemented (phase 2). ` +
      `Selected kind="${plan.kind}" via DATABASE_URL.`,
  )
}
