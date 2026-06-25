import { createAuth, drizzleAdapter } from '@rooster/auth'
import { loadConfig } from '@rooster/config'
import { createServices } from '@rooster/core'
import { createLibsqlWebDrizzle, createRepositories, sqliteSchema } from '@rooster/db/web'
import type { Hono } from 'hono'
import { createApp } from './app.js'
import * as authSchema from './auth-schema.js'
import { type ServerContext, webhookCrowNotifier } from './context.js'

/**
 * Cloudflare Workers entry. Backed by libSQL/Turso over HTTP — one drizzle
 * instance serves both the Rooster domain repositories and better-auth (via its
 * drizzle adapter). No `pg` or native libSQL bindings reach the bundle, so this
 * runs on the edge. Requires `nodejs_compat` (for `node:crypto`); see
 * wrangler.toml and docs/SELF_HOSTING.md.
 *
 * Migrate out-of-band before first use:
 *   DATABASE_URL=libsql://… pnpm --filter @rooster/db db:migrate
 *   DATABASE_URL=…          pnpm --filter @rooster/server auth:migrate
 */
type WorkerEnv = Record<string, string | undefined>

let app: Hono | undefined

function buildApp(env: WorkerEnv): Hono {
  const config = loadConfig(env)
  if (config.database.kind !== 'libsql') {
    throw new Error('Workers deployment requires a libsql:// (Turso) DATABASE_URL')
  }
  const drizzleDb = createLibsqlWebDrizzle(config.database.url, config.database.authToken)
  const repositories = createRepositories(drizzleDb, sqliteSchema)
  const services = createServices(repositories, {
    crowNotifier: webhookCrowNotifier(config.notifications.crowWebhookUrl),
  })
  const auth = createAuth({
    config,
    database: drizzleAdapter(drizzleDb, { provider: 'sqlite', schema: authSchema }),
  })

  const ctx: ServerContext = {
    config,
    db: { kind: 'libsql', repositories, close: async () => {} },
    services,
    auth,
  }
  return createApp(ctx)
}

export default {
  fetch(request: Request, env: WorkerEnv): Response | Promise<Response> {
    app ??= buildApp(env)
    return app.fetch(request)
  },
}
