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
    /**
     * Create an email/password account server-side (used by the first-run admin
     * bootstrap). Bypasses the transport sign-up gate since it isn't an HTTP
     * call. Returns the new better-auth user.
     */
    signUpEmail: (input: {
      body: { email: string; password: string; name: string }
    }) => Promise<{ token?: string | null; user: { id: string; email: string; name: string } }>
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
 * Build the Rooster auth server: better-auth with social login for every
 * provider whose credentials are present (GitHub, Google, Microsoft, Apple,
 * Discord, GitLab), opt-in email verification, and the MCP plugin acting as an
 * OAuth 2.1 authorization server — PKCE required, Dynamic Client Registration
 * enabled, scopes restricted to the Rooster permission set.
 */
export function createAuth({
  config,
  database,
  loginPage = '/login',
  sendEmail,
}: CreateAuthOptions): RoosterAuth {
  // A real sender (Resend / webhook) is supplied in production; dev/self-host
  // falls back to the console logger. Email verification is only safe to enforce
  // when a real sender exists — otherwise users could never receive the link.
  const sender = sendEmail ?? consoleEmailSender
  const verificationEnabled = config.requireEmailVerification && sendEmail !== undefined

  // Enable every social provider whose credentials are present. Adding a
  // provider is just a config entry here + its env vars; the login page renders
  // a button per configured provider automatically.
  const socialProviders = {} as Record<string, { clientId: string; clientSecret: string }>
  for (const [name, creds] of Object.entries(config.oauthProviders)) {
    if (creds)
      socialProviders[name] = { clientId: creds.clientId, clientSecret: creds.clientSecret }
  }

  const auth = betterAuth({
    baseURL: config.baseUrl,
    secret: config.authSecret,
    database,
    // Email/password lets the dashboard work without external OAuth providers
    // configured; social providers are added on top when credentials are present.
    // `sendResetPassword` routes through the host's email seam (webhook in prod,
    // console logger by default). Email verification is opt-in
    // (ROOSTER_REQUIRE_EMAIL_VERIFICATION) and only enforced when a real sender
    // is configured, so it can never lock users out by accident.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: verificationEnabled,
      sendResetPassword: async ({ user, url }) => {
        await sender.send({
          to: user.email,
          subject: 'Reset your Rooster password',
          text: `Reset your Rooster password by opening this link:\n\n${url}\n\nIf you didn't request this, you can ignore this email.`,
          kind: 'reset-password',
          url,
        })
      },
    },
    // Only wire verification email when enabled — sendOnSignUp makes better-auth
    // dispatch the link as part of sign-up.
    emailVerification: verificationEnabled
      ? {
          sendOnSignUp: true,
          sendVerificationEmail: async ({ user, url }) => {
            await sender.send({
              to: user.email,
              subject: 'Verify your Rooster email',
              text: `Confirm your Rooster email by opening this link:\n\n${url}\n\nIf you didn't create this account, you can ignore this email.`,
              kind: 'verify-email',
              url,
            })
          },
        }
      : undefined,
    socialProviders: socialProviders as BetterAuthOptions['socialProviders'],
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
