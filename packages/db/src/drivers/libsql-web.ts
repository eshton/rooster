import { createClient } from '@libsql/client/web'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'
import { drizzle } from 'drizzle-orm/libsql/web'
import type { Database } from '../database.js'
import { createRepositories } from '../repositories/impl.js'
import { sqliteSchema } from '../schema/sqlite.js'

type WebDrizzle = LibSQLDatabase<Record<string, never>>

/**
 * Build a Drizzle instance over the libSQL **HTTP** client. Unlike the node
 * client this has no native bindings and runs on Cloudflare Workers / edge
 * runtimes. Remote only — `url` must be `libsql://…` or `https://…` (Turso),
 * not a local `file:` path. Migrations are applied out-of-band (run
 * `@rooster/db db:migrate` from Node/CI against the same URL).
 */
export function createLibsqlWebDrizzle(url: string, authToken?: string): WebDrizzle {
  const client = createClient({ url, authToken })
  return drizzle(client) as unknown as WebDrizzle
}

/** A Workers-compatible {@link Database} backed by libSQL/Turso over HTTP. */
export function createLibsqlWebDatabase(url: string, authToken?: string): Database {
  const db = createLibsqlWebDrizzle(url, authToken)
  return {
    kind: 'libsql',
    repositories: createRepositories(db, sqliteSchema),
    async close() {
      // The HTTP client holds no persistent connection to close.
    },
  }
}
