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
    /**
     * Resolve an MCP bearer token to the authenticated better-auth *account*
     * (id/email/name) plus the token's client + scopes. Unlike `getMcpSession`
     * (which returns only the token record), this joins in the user row so the
     * identity bridge can anchor a Rooster user to a stable account id. Returns
     * `null` when the request carries no valid MCP session.
     */
    getMcpUser: (input: { headers: Headers }) => Promise<{
      id: string
      email: string
      name: string
      clientId: string
      scopes: string
    } | null>
    [endpoint: string]: unknown
  }
  options: unknown
  [key: string]: unknown
}

/** A transactional email Rooster asks the host to deliver. */
export interface EmailMessage {
  to: string
  subject: string
  text: string
  /** Categorizes the message so a webhook consumer can route it. */
  kind: 'reset-password' | 'verify-email'
  /** The action link (reset / verification URL) embedded in `text`. */
  url: string
}

/**
 * Pluggable transactional-email seam. Rooster never talks to an SMTP/ESP
 * directly; the host supplies a sender (e.g. an outbound webhook). When none is
 * supplied, {@link createAuth} falls back to a console logger so password reset
 * still works in dev/self-host without any email provider configured.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>
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
  /**
   * How to deliver transactional email (password reset). Defaults to a
   * console logger that prints the link — fine for dev/self-host, but a real
   * sender should be supplied in production so users can reset their password.
   */
  sendEmail?: EmailSender
}

/** Logs the email (link included) to stdout. The default when no sender is given. */
const consoleEmailSender: EmailSender = {
  async send({ to, subject, url }) {
    console.info(`[rooster:email] to=${to} subject=${JSON.stringify(subject)} url=${url}`)
  },
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
  sendEmail = consoleEmailSender,
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
    // `sendResetPassword` routes through the host's email seam (webhook in prod,
    // console logger by default). Email verification is intentionally NOT
    // required — turning it on without a configured sender would lock users out.
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user, url }) => {
        await sendEmail.send({
          to: user.email,
          subject: 'Reset your Rooster password',
          text: `Reset your Rooster password by opening this link:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
          kind: 'reset-password',
          url,
        })
      },
    },
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
  const rooster = auth as unknown as RoosterAuth

  // Join the MCP token's user id to the better-auth user row. `$context`
  // resolves the (adapter-backed) internal adapter, so this stays portable
  // across the memory, drizzle and pg adapters.
  const authContext = (auth as unknown as { $context: Promise<AuthContextLike> }).$context
  rooster.api.getMcpUser = async ({ headers }) => {
    const token = await rooster.api.getMcpSession({ headers })
    if (!token) return null
    const user = await (await authContext).internalAdapter.findUserById(token.userId)
    if (!user) return null
    return {
      id: token.userId,
      email: user.email ?? '',
      name: user.name ?? '',
      clientId: token.clientId,
      scopes: token.scopes,
    }
  }

  return rooster
}

/** Minimal shape of better-auth's resolved `$context` that we depend on. */
interface AuthContextLike {
  internalAdapter: {
    findUserById: (id: string) => Promise<{ email?: string; name?: string } | null>
  }
}
