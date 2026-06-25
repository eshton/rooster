/**
 * Configuration entry for the better-auth CLI (`@better-auth/cli`), used to
 * create/apply better-auth's OWN tables (user, session, account, oauth*, ...).
 * These are separate from the Rooster domain schema.
 *
 * Run it once against your database as a setup step (see docs/SELF_HOSTING.md):
 *
 *   # Postgres (Node / Docker / Vercel):
 *   DATABASE_URL=postgres://…                       pnpm --filter @rooster/server auth:migrate
 *   # libSQL / Turso (Cloudflare Workers) or local SQLite:
 *   DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=…   pnpm --filter @rooster/server auth:migrate
 *
 * The Workers runtime reads these same tables through better-auth's drizzle
 * adapter over libSQL-HTTP (see apps/server/src/worker.ts); both adapters use
 * better-auth's canonical schema, so the tables created here match at runtime.
 * Not used at runtime — the server builds its own auth instance.
 */
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { createAuth } from '@rooster/auth'
import { loadConfig } from '@rooster/config'
import pg from 'pg'

const config = loadConfig()

const database =
  config.database.kind === 'postgres'
    ? new pg.Pool({ connectionString: config.database.url })
    : {
        dialect: new LibsqlDialect({
          url: config.database.url,
          authToken: config.database.authToken,
        }),
        type: 'sqlite' as const,
      }

export const auth = createAuth({ config, database })
