import { enrollmentPolicySchema } from '@rooster/schema'
import { z } from 'zod'
import { type DbKind, resolveDbKind } from './db-driver.js'
import { detectPlatform, type Platform } from './platform.js'

/**
 * Raw environment schema. Coercions and cross-field derivations (db kind,
 * platform) happen in `loadConfig`, not here, so this stays a faithful 1:1
 * mirror of `.env.example`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ROOSTER_BASE_URL: z.url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().positive().max(65_535).default(3000),

  DATABASE_URL: z.string().min(1),
  DATABASE_AUTH_TOKEN: z.string().optional(),

  ROOSTER_AUTH_SECRET: z.string().min(16, 'ROOSTER_AUTH_SECRET must be at least 16 chars'),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  ROOSTER_ENROLLMENT_POLICY: enrollmentPolicySchema.default('token'),
  ROOSTER_ENROLLMENT_TOKEN: z.string().optional(),

  /** Gates agent-first tenant self-registration. Unset = open (self-host). */
  ROOSTER_SIGNUP_TOKEN: z.string().optional(),

  /**
   * Close public email/password sign-up (the dashboard form / `/api/auth/
   * sign-up/email`). New members then join only by invite. For internal teams
   * and single-user self-hosts. Accepts `true`/`1`.
   */
  ROOSTER_DISABLE_SIGNUP: z.string().optional(),

  /**
   * Optional first-run admin. When email + password are set and the email has
   * no Rooster user yet, the server creates the account and a starter workspace
   * on startup — a zero-friction "just me" / internal self-host: set these,
   * start, log in. Works even with sign-up disabled. Password ≥ 8 chars.
   */
  ROOSTER_ADMIN_EMAIL: z.email().optional(),
  ROOSTER_ADMIN_PASSWORD: z.string().min(8).optional(),
  ROOSTER_ADMIN_WORKSPACE: z.string().optional(),
  ROOSTER_ADMIN_PROJECT_KEY: z.string().optional(),

  ROOSTER_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

  /**
   * TTL (seconds) for the per-request resolved-actor cache on the `/mcp` hot
   * path. A short window skips the identity-resolution chain on repeat calls;
   * role/scope/membership changes self-heal within it. `0` disables the cache.
   */
  ROOSTER_MCP_ACTOR_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(30),

  /** Optional outbound webhook for `crow` (assignee wake) notifications. */
  ROOSTER_CROW_WEBHOOK_URL: z.url().optional(),

  /**
   * Optional outbound webhook for transactional email (password reset). Unset =
   * email is logged to stdout (fine for dev/self-host; not for production).
   */
  ROOSTER_EMAIL_WEBHOOK_URL: z.url().optional(),

  /**
   * Resend transactional-email delivery (https://resend.com). When both the
   * API key and from-address are set, password-reset mail is sent via Resend's
   * HTTP API — the edge-friendly default for the hosted instance. Takes
   * precedence over the webhook; both unset = email is logged to stdout.
   */
  RESEND_API_KEY: z.string().optional(),
  ROOSTER_EMAIL_FROM: z.string().optional(),
})

export type RawEnv = z.infer<typeof envSchema>

export interface OAuthProvider {
  clientId: string
  clientSecret: string
}

export interface RoosterConfig {
  nodeEnv: RawEnv['NODE_ENV']
  baseUrl: string
  port: number
  platform: Platform
  database: {
    url: string
    authToken?: string
    kind: DbKind
  }
  authSecret: string
  oauthProviders: {
    github?: OAuthProvider
    google?: OAuthProvider
  }
  enrollment: {
    policy: RawEnv['ROOSTER_ENROLLMENT_POLICY']
    token?: string
  }
  /** Tenant self-registration gate. `signupToken` unset = open registration. */
  onboarding: {
    signupToken?: string
    /** When true, public email/password sign-up is closed (invite-only). */
    disableSignup: boolean
  }
  /**
   * Optional first-run admin bootstrap (self-host). Present only when both
   * email and password are configured.
   */
  admin?: {
    email: string
    password: string
    /** Starter workspace name (default `My Workspace`). */
    workspace: string
    /** Starter team/ticket key prefix (default `TASK`). */
    projectKey: string
  }
  mcp: {
    rateLimitPerMinute: number
    /** TTL (seconds) for the resolved-actor cache; 0 disables it. */
    actorCacheTtlSeconds: number
  }
  /** Outbound notifications. `crowWebhookUrl` unset = crow is audit-only. */
  notifications: {
    crowWebhookUrl?: string
    /** Webhook for transactional email; unset = email is logged to stdout. */
    emailWebhookUrl?: string
    /** Resend API key for transactional email (paired with `emailFrom`). */
    emailResendApiKey?: string
    /** Verified from-address for transactional email (e.g. `Rooster <no-reply@…>`). */
    emailFrom?: string
  }
}

function provider(id?: string, secret?: string): OAuthProvider | undefined {
  return id && secret ? { clientId: id, clientSecret: secret } : undefined
}

/**
 * Validate the environment and derive the typed runtime config. Throws a
 * single aggregated error listing every invalid key so misconfiguration is
 * obvious at startup (secure-first: never boot half-configured).
 */
export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): RoosterConfig {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid Rooster environment configuration:\n${issues}`)
  }
  const env = parsed.data

  // Admin bootstrap is all-or-nothing: requiring both avoids a half-configured
  // account that can't log in.
  if (Boolean(env.ROOSTER_ADMIN_EMAIL) !== Boolean(env.ROOSTER_ADMIN_PASSWORD)) {
    throw new Error(
      'Invalid Rooster environment configuration:\n  - ROOSTER_ADMIN_EMAIL and ROOSTER_ADMIN_PASSWORD must be set together',
    )
  }
  const admin =
    env.ROOSTER_ADMIN_EMAIL && env.ROOSTER_ADMIN_PASSWORD
      ? {
          email: env.ROOSTER_ADMIN_EMAIL,
          password: env.ROOSTER_ADMIN_PASSWORD,
          workspace: env.ROOSTER_ADMIN_WORKSPACE ?? 'My Workspace',
          projectKey: env.ROOSTER_ADMIN_PROJECT_KEY ?? 'TASK',
        }
      : undefined

  return {
    nodeEnv: env.NODE_ENV,
    baseUrl: env.ROOSTER_BASE_URL.replace(/\/+$/, ''),
    port: env.PORT,
    platform: detectPlatform(source),
    database: {
      url: env.DATABASE_URL,
      authToken: env.DATABASE_AUTH_TOKEN,
      kind: resolveDbKind(env.DATABASE_URL),
    },
    authSecret: env.ROOSTER_AUTH_SECRET,
    oauthProviders: {
      github: provider(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
      google: provider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    },
    enrollment: {
      policy: env.ROOSTER_ENROLLMENT_POLICY,
      token: env.ROOSTER_ENROLLMENT_TOKEN,
    },
    onboarding: {
      signupToken: env.ROOSTER_SIGNUP_TOKEN,
      disableSignup: env.ROOSTER_DISABLE_SIGNUP === 'true' || env.ROOSTER_DISABLE_SIGNUP === '1',
    },
    admin,
    mcp: {
      rateLimitPerMinute: env.ROOSTER_MCP_RATE_LIMIT_PER_MINUTE,
      actorCacheTtlSeconds: env.ROOSTER_MCP_ACTOR_CACHE_TTL_SECONDS,
    },
    notifications: {
      crowWebhookUrl: env.ROOSTER_CROW_WEBHOOK_URL,
      emailWebhookUrl: env.ROOSTER_EMAIL_WEBHOOK_URL,
      emailResendApiKey: env.RESEND_API_KEY,
      emailFrom: env.ROOSTER_EMAIL_FROM,
    },
  }
}
