/**
 * Configuration entry for the better-auth CLI (`@better-auth/cli`), used to
 * create/apply better-auth's OWN tables (user, session, account, oauth*, ...).
 * These are separate from the Rooster domain schema.
 *
 * better-auth owns and migrates these tables itself; run it once against your
 * database as a setup step (see docs/SELF_HOSTING.md):
 *
 *   DATABASE_URL=postgres://... pnpm --filter @rooster/server auth:migrate
 *
 * Requires a Postgres DATABASE_URL (better-auth's built-in adapter manages the
 * tables there). Not used at runtime — the server builds its own auth instance.
 */
import { createAuth } from '@rooster/auth'
import { loadConfig } from '@rooster/config'
import pg from 'pg'

const config = loadConfig()

if (config.database.kind !== 'postgres') {
  throw new Error(
    'auth migrations target Postgres: set DATABASE_URL to a postgres:// connection string',
  )
}

export const auth = createAuth({
  config,
  database: new pg.Pool({ connectionString: config.database.url }),
})
