import { createAuth, drizzleAdapter } from '@rooster/auth'
import { loadConfig } from '@rooster/config'
import { createServices, InMemoryActorCache } from '@rooster/core'
import {
  createLibsqlWebDrizzle,
  createRepositories,
  ensureEmbeddingsStore,
  sqliteSchema,
} from '@rooster/db/web'
import type { Hono } from 'hono'
import { KvActorCache, type KvNamespace } from './actor-cache-kv.js'
import { createApp } from './app.js'
import * as authSchema from './auth-schema.js'
import type { ServerContext } from './context.js'
import { webhookCrowNotifier } from './crow-webhook.js'
import { emailSenderFor } from './email.js'
import { embedderFor } from './embedder-http.js'

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

let appPromise: Promise<Hono> | undefined

async function buildApp(env: WorkerEnv): Promise<Hono> {
  const config = loadConfig(env)
  if (config.database.kind !== 'libsql') {
    throw new Error('Workers deployment requires a libsql:// (Turso) DATABASE_URL')
  }
  const drizzleDb = createLibsqlWebDrizzle(config.database.url, config.database.authToken)
  // Provision the runtime embeddings store at the app's configured dimension, so
  // ROOSTER_EMBEDDING_DIMS is the single source of truth for the table size — no
  // dependency on the out-of-band db:migrate environment carrying it (ROO-41).
  // Best-effort + idempotent (IF NOT EXISTS); runs once per isolate cold start.
  await ensureEmbeddingsStore(drizzleDb, config.embeddingDims)
  const repositories = createRepositories(drizzleDb, sqliteSchema)
  const services = createServices(repositories, {
    crowNotifier: webhookCrowNotifier(config.notifications.crowWebhookUrl),
    embedder: embedderFor(config),
  })
  const auth = createAuth({
    config,
    database: drizzleAdapter(drizzleDb, { provider: 'sqlite', schema: authSchema }),
    sendEmail: emailSenderFor(config),
  })

  // Prefer a shared KV-backed actor cache when a `ROOSTER_ACTOR_CACHE` KV
  // namespace is bound (see wrangler.toml); otherwise fall back to a per-isolate
  // in-memory cache (still a valid short-TTL cache, just not shared across
  // isolates/regions).
  const kv = (env as Record<string, unknown>).ROOSTER_ACTOR_CACHE as KvNamespace | undefined
  const actorCache = kv ? new KvActorCache(kv) : new InMemoryActorCache()

  const ctx: ServerContext = {
    config,
    db: { kind: 'libsql', repositories, close: async () => {} },
    services,
    auth,
    actorCache,
  }
  return createApp(ctx)
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Liveness must never depend on config or the app building — answer /healthz
    // before buildApp so a misconfig can't take the health check down with it.
    if (new URL(request.url).pathname === '/healthz') {
      return Response.json({ ok: true })
    }
    let app: Hono
    try {
      appPromise ??= buildApp(env)
      app = await appPromise
    } catch (err) {
      // A config error (e.g. a half-set optional provider) must surface as a
      // clean, handled 500 — not an uncaught exception that crash-loops the
      // isolate (CF 1101) on every route. Clear the cached rejection so a later
      // request can retry the build once the environment is fixed.
      appPromise = undefined
      const message = err instanceof Error ? err.message : String(err)
      console.error('[worker] failed to build app:', message)
      return Response.json({ error: 'server_misconfigured', message }, { status: 500 })
    }
    return app.fetch(request)
  },
}
