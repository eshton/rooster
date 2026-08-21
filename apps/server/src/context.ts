import { createAuth, drizzleAdapter, memoryAdapter, type RoosterAuth } from '@rooster/auth'
import type { RoosterConfig } from '@rooster/config'
import { type ActorCache, createServices, type Services } from '@rooster/core'
import { createDatabase, type Database } from '@rooster/db'
import pg from 'pg'
import * as authSchema from './auth-schema.js'
import { ensureAuthTables } from './auth-store.js'
import { webhookCrowNotifier } from './crow-webhook.js'
import { emailSenderFor } from './email.js'
import { embedderFor } from './embedder-http.js'
import { rerankerFor } from './reranker-http.js'

type AuthDatabase = Parameters<typeof createAuth>[0]['database']

/**
 * Choose better-auth's storage. Postgres gets a real connection pool (better-auth
 * owns its own tables there — applied via its CLI). A durable SQLite/libSQL DB
 * (a file or Turso) runs better-auth through the drizzle adapter on the SAME
 * connection, so logins persist across restarts (ROO-66). Only the in-memory
 * test DB (`file::memory:`) falls back to the in-memory adapter.
 */
async function resolveAuthDatabase(config: RoosterConfig, db: Database): Promise<AuthDatabase> {
  if (config.database.kind === 'postgres') {
    return new pg.Pool({ connectionString: config.database.url })
  }
  // In-memory test/dev DB, or a driver without a durable handle: the in-memory
  // adapter needs its model tables pre-declared (it doesn't create them on read).
  if (config.database.url === 'file::memory:' || !db.libsql) {
    return memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      oauthApplication: [],
      oauthAccessToken: [],
      oauthConsent: [],
      jwks: [],
    })
  }
  // Durable: create better-auth's tables on the shared libSQL connection, then
  // let it run through the drizzle adapter (parity with the Cloudflare Worker).
  await ensureAuthTables(db.libsql.execute)
  return drizzleAdapter(db.libsql.drizzle as never, { provider: 'sqlite', schema: authSchema })
}

/** The assembled runtime: config + connected DB + domain services + auth. */
export interface ServerContext {
  config: RoosterConfig
  db: Database
  services: Services
  auth: RoosterAuth
  /**
   * Optional resolved-actor cache for the `/mcp` hot path. Wired at the server
   * entries (Node: in-memory; edge: KV-backed); absent in tests/dev → the
   * endpoint resolves every request fresh.
   */
  actorCache?: ActorCache
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
  const services = createServices(db.repositories, {
    crowNotifier: webhookCrowNotifier(config.notifications.crowWebhookUrl),
    embedder: embedderFor(config),
    chunkConfig: config.chunking,
    ragOverfetch: config.ragOverfetch,
    reranker: rerankerFor(config),
  })
  const auth = createAuth({
    config,
    database: opts.authDatabase ?? (await resolveAuthDatabase(config, db)),
    sendEmail: emailSenderFor(config),
  })
  return { config, db, services, auth }
}
