import { serve } from '@hono/node-server'
import { loadConfig } from '@rooster/config'
import { createApp } from './app.js'
import { bootstrapAdmin } from './bootstrap-admin.js'
import { createServerContext } from './context.js'

/** Node / self-host entry point: `node dist/node.js`. */
async function main() {
  const config = loadConfig()
  const ctx = await createServerContext(config, { migrate: true })
  await bootstrapAdmin(ctx)
  const app = createApp(ctx)

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
