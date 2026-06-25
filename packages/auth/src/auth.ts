import type { RoosterConfig } from '@rooster/config'
import { type BetterAuthOptions, betterAuth } from 'better-auth'
import { mcp } from 'better-auth/plugins'
import { ROOSTER_SCOPES } from './scopes.js'

/**
 * The auth surface Rooster consumes. better-auth's plugin-augmented instance
 * type is not portable across declaration files, so we expose an explicit,
 * nameable interface for the handful of endpoints we use (the index signatures
 * keep the rest of better-auth's API reachable, untyped).
 */
export interface RoosterAuth {
  handler: (request: Request) => Promise<Response>
  api: {
    getMcpSession: (input: {
      headers: Headers
    }) => Promise<{ clientId: string; scopes: string; userId: string } | null>
    getSession: (input: {
      headers: Headers
    }) => Promise<{ user: { id: string; email: string; name: string } } | null>
    [endpoint: string]: unknown
  }
  options: unknown
  [key: string]: unknown
}

export interface CreateAuthOptions {
  config: RoosterConfig
  /**
   * The better-auth database. Use `memoryAdapter({})` for dev/tests, or
   * `drizzleAdapter(...)` for production (its tables are managed by better-auth,
   * separate from the Rooster domain schema).
   */
  database: BetterAuthOptions['database']
  /** Override the human login page path (defaults to `/login`). */
  loginPage?: string
}

/**
 * Build the Rooster auth server: better-auth with GitHub/Google social login
 * (enabled only when credentials are present) and the MCP plugin acting as an
 * OAuth 2.1 authorization server — PKCE required, Dynamic Client Registration
 * enabled, scopes restricted to the Rooster permission set.
 */
export function createAuth({
  config,
  database,
  loginPage = '/login',
}: CreateAuthOptions): RoosterAuth {
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {}
  if (config.oauthProviders.github) {
    socialProviders.github = {
      clientId: config.oauthProviders.github.clientId,
      clientSecret: config.oauthProviders.github.clientSecret,
    }
  }
  if (config.oauthProviders.google) {
    socialProviders.google = {
      clientId: config.oauthProviders.google.clientId,
      clientSecret: config.oauthProviders.google.clientSecret,
    }
  }

  const auth = betterAuth({
    baseURL: config.baseUrl,
    secret: config.authSecret,
    database,
    // Email/password lets the dashboard work without external OAuth providers
    // configured; GitHub/Google are added on top when credentials are present.
    emailAndPassword: { enabled: true },
    socialProviders,
    plugins: [
      mcp({
        loginPage,
        resource: `${config.baseUrl}/mcp`,
        oidcConfig: {
          loginPage,
          requirePKCE: true,
          allowDynamicClientRegistration: true,
          scopes: ROOSTER_SCOPES,
        },
      }),
    ],
  })

  // better-auth's inferred instance type is not portable in .d.ts output; the
  // runtime object matches RoosterAuth (handler + the api endpoints we use).
  return auth as unknown as RoosterAuth
}
