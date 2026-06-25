// Generation-only config: emits better-auth's Drizzle (sqlite) schema for the
// Workers runtime via `@better-auth/cli generate`. Not used at runtime.
import { createAuth, drizzleAdapter } from '@rooster/auth'
import { loadConfig } from '@rooster/config'

const config = loadConfig()
export const auth = createAuth({
  config,
  database: drizzleAdapter({}, { provider: 'sqlite' }),
})
