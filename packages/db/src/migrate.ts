import { loadConfig } from '@rooster/config'
import { createDatabase } from './database.js'

/**
 * Apply pending migrations for the dialect implied by `DATABASE_URL`, then
 * exit. Use this as a one-off deploy/CI step (e.g. on Vercel where you don't
 * want to migrate on every cold start). The Node self-host entry migrates on
 * startup instead.
 *
 *   pnpm --filter @rooster/db db:migrate
 */
async function main() {
  const config = loadConfig()
  const db = await createDatabase(config, { migrate: true })
  console.log(`✓ Applied ${config.database.kind} migrations`)
  await db.close()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
