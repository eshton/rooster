import { randomBytes } from 'node:crypto'
import { serve } from '@hono/node-server'
import { loadConfig } from '@rooster/config'
import { InMemoryActorCache } from '@rooster/core'
import { createApp } from './app.js'
import { bootstrapAdmin } from './bootstrap-admin.js'
import { createServerContext } from './context.js'

/** Node / self-host entry point: `node dist/node.js`. */
async function main() {
  const config = loadConfig()

  // Local mode: mint a strong token if the operator didn't set one. Done here
  // (Node entry) so the edge/Worker config path stays free of node:crypto.
  if (config.localMode && !config.localMode.token) {
    config.localMode.token = randomBytes(24).toString('base64url')
  }

  const ctx = await createServerContext(config, { migrate: true })
  await bootstrapAdmin(ctx)

  if (config.localMode) {
    console.warn('')
    console.warn('⚠️  ROOSTER LOCAL MODE — token-only auth, no OAuth, single owner.')
    console.warn('    Anyone who can reach this port + token has full owner access.')
    console.warn('    Bind to localhost only, e.g. docker run -p 127.0.0.1:3000:3000 …')
    console.warn(`    MCP bearer token:  ${config.localMode.token}`)
    console.warn('    Set ROOSTER_LOCAL_TOKEN to keep this token stable across restarts.')
    console.warn('')
  }
  // In-memory actor cache: this is a single long-running process, so it persists
  // across requests and short-circuits the /mcp identity-resolution chain.
  const app = createApp({ ...ctx, actorCache: new InMemoryActorCache() })

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`🐓 Rooster listening on http://localhost:${info.port} (${config.baseUrl})`)
    console.log(`   MCP endpoint:   ${config.baseUrl}/mcp`)
    console.log(`   Agent docs:     ${config.baseUrl}/llms.txt`)
  })
}

main().catch((err) => {
  console.error('Failed to start Rooster:', err)
  process.exit(1)
})
