import { fileURLToPath } from 'node:url'
import type { RoosterConfig } from '@rooster/config'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import type { CreateDatabaseOptions, Database } from '../database.js'
import { createRepositories } from '../repositories/impl.js'
import { pgSchema } from '../schema/pg.js'
import type { sqliteSchema } from '../schema/sqlite.js'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations/pg', import.meta.url))

/**
 * Driver for the `postgres` kind (node-postgres).
 *
 * ⚠️ FROZEN / community-maintained. SQLite/libSQL (Turso) is the single
 * first-class, CI-tested target; this driver is preserved (and kept compiling)
 * for self-hosters who prefer Postgres, but is not exercised in CI. libSQL
 * native vector search has no equivalent on this path.
 */
export async function createPostgresDatabase(
  config: RoosterConfig,
  opts: CreateDatabaseOptions,
): Promise<Database> {
  const pool = new pg.Pool({ connectionString: config.database.url })
  const db = drizzle(pool)

  if (opts.migrate) {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  }

  // Single type-bridge: the repository implementation is dialect-agnostic at
  // runtime and both dialect schemas are structurally identical, so the
  // libSQL-typed factory drives the Postgres connection unchanged.
  const repositories = createRepositories(
    db as unknown as LibSQLDatabase<Record<string, never>>,
    pgSchema as unknown as typeof sqliteSchema,
  )

  return {
    kind: 'postgres',
    repositories,
    async close() {
      await pool.end()
    },
  }
}
