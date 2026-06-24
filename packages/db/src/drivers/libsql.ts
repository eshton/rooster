import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import type { RoosterConfig } from '@rooster/config'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import type { CreateDatabaseOptions, Database } from '../database.js'
import { createRepositories } from '../repositories/impl.js'
import { sqliteSchema } from '../schema/sqlite.js'

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations/sqlite', import.meta.url))

/** Driver for both the `sqlite` (local file) and `libsql` (Turso) kinds. */
export async function createLibsqlDatabase(
  config: RoosterConfig,
  opts: CreateDatabaseOptions,
): Promise<Database> {
  // `file::memory:` is our portable spelling of an in-memory SQLite DB (so the
  // DATABASE_URL still carries a `file:` scheme that resolves to the sqlite kind).
  const url = config.database.url === 'file::memory:' ? ':memory:' : config.database.url
  const client = createClient({ url, authToken: config.database.authToken })
  const db = drizzle(client)

  if (opts.migrate) {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  }

  return {
    kind: config.database.kind,
    repositories: createRepositories(db, sqliteSchema),
    async close() {
      client.close()
    },
  }
}
