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

  ROOSTER_MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

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
  }
  mcp: {
    rateLimitPerMinute: number
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
    },
    mcp: {
      rateLimitPerMinute: env.ROOSTER_MCP_RATE_LIMIT_PER_MINUTE,
    },
    notifications: {
      crowWebhookUrl: env.ROOSTER_CROW_WEBHOOK_URL,
      emailWebhookUrl: env.ROOSTER_EMAIL_WEBHOOK_URL,
      emailResendApiKey: env.RESEND_API_KEY,
      emailFrom: env.ROOSTER_EMAIL_FROM,
    },
  }
}
