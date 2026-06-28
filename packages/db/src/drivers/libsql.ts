import { fileURLToPath } from 'node:url'
import { createClient } from '@libsql/client'
import type { RoosterConfig } from '@rooster/config'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import type { CreateDatabaseOptions, Database } from '../database.js'
import { createRepositories } from '../repositories/impl.js'
import { sqliteSchema } from '../schema/sqlite.js'
import { ensureEmbeddingsStore } from '../vector.js'

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
  // Create the polymorphic embeddings store (table + unique index + functional
  // ANN index), sized from the configured embedding dimension. Kept out of the
  // generated migrations because the dimension is runtime-configurable.
  // Best-effort + idempotent; runs after migrate so the `db:migrate` CLI
  // provisions it for Turso too.
  await ensureEmbeddingsStore(db, config.embeddingDims)

  return {
    kind: config.database.kind,
    repositories: createRepositories(db, sqliteSchema),
    async close() {
      client.close()
    },
  }
}
