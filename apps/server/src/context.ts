import { createAuth, memoryAdapter, type RoosterAuth } from '@rooster/auth'
import type { RoosterConfig } from '@rooster/config'
import { createServices, type Services } from '@rooster/core'
import { createDatabase, type Database } from '@rooster/db'
import pg from 'pg'

type AuthDatabase = Parameters<typeof createAuth>[0]['database']

/**
 * Choose better-auth's storage. Postgres deploys get a real connection pool
 * (better-auth owns its own tables there — applied via its CLI; see the
 * self-host setup docs). Dev / SQLite / tests use the in-memory adapter, which
 * is fine for a single process but not for serverless.
 */
function authDatabaseFor(config: RoosterConfig): AuthDatabase {
  if (config.database.kind === 'postgres') {
    return new pg.Pool({ connectionString: config.database.url })
  }
  return memoryAdapter({})
}

/** The assembled runtime: config + connected DB + domain services + auth. */
export interface ServerContext {
  config: RoosterConfig
  db: Database
  services: Services
  auth: RoosterAuth
}

export interface CreateContextOptions {
  /** Apply domain migrations on connect (handy for dev/self-host single-host). */
  migrate?: boolean
  /**
   * better-auth database. Defaults to an in-memory adapter, which is fine for a
   * single long-running Node process or local dev but NOT for serverless
   * (state is lost between invocations) — production wires `drizzleAdapter`
   * over the same DATABASE_URL once better-auth's tables are migrated.
   */
  authDatabase?: Parameters<typeof createAuth>[0]['database']
}

/** Build the server context from validated config. */
export async function createServerContext(
  config: RoosterConfig,
  opts: CreateContextOptions = {},
): Promise<ServerContext> {
  const db = await createDatabase(config, { migrate: opts.migrate ?? false })
  const services = createServices(db.repositories)
  const auth = createAuth({ config, database: opts.authDatabase ?? authDatabaseFor(config) })
  return { config, db, services, auth }
}
