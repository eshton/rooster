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

  /**
   * Public roadmap page (served at `/roadmap`, unauthenticated). Opt-in: set
   * both the workspace slug and the project key whose tickets should be exposed
   * publicly, sorted by priority. Unset = no public roadmap (the route 404s).
   * An optional heading overrides the default "<Project> roadmap" title.
   */
  ROOSTER_ROADMAP_ORG_SLUG: z.string().optional(),
  ROOSTER_ROADMAP_PROJECT_KEY: z.string().optional(),
  ROOSTER_ROADMAP_TITLE: z.string().optional(),

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

  /**
   * Embeddings for semantic (vector) search. When the URL + API key are set,
   * tickets (and later messages/context files) are embedded and become
   * searchable via libSQL native vectors. OpenAI-compatible API by default.
   * Unset = semantic search is unconfigured (recall tools report so). The model
   * must emit 1536-dim vectors (the fixed `F32_BLOB(1536)` column).
   */
  ROOSTER_EMBEDDING_URL: z.url().optional(),
  ROOSTER_EMBEDDING_API_KEY: z.string().optional(),
  ROOSTER_EMBEDDING_MODEL: z.string().optional(),
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
  /**
   * Optional public roadmap. Present only when both the workspace slug and the
   * project key are configured; the `/roadmap` page then renders that project's
   * tickets publicly. `title` overrides the default heading.
   */
  roadmap?: {
    orgSlug: string
    projectKey: string
    title?: string
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
  /**
   * Optional embeddings provider for semantic search. Present only when both the
   * URL and API key are configured; otherwise semantic search is unconfigured.
   */
  embedding?: {
    url: string
    apiKey: string
    /** Embedding model name (default `text-embedding-3-small`). */
    model: string
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
  // The public roadmap needs both the workspace and the project to resolve a
  // target; requiring both together avoids a half-configured, never-rendering
  // page.
  if (Boolean(env.ROOSTER_ROADMAP_ORG_SLUG) !== Boolean(env.ROOSTER_ROADMAP_PROJECT_KEY)) {
    throw new Error(
      'Invalid Rooster environment configuration:\n  - ROOSTER_ROADMAP_ORG_SLUG and ROOSTER_ROADMAP_PROJECT_KEY must be set together',
    )
  }
  const roadmap =
    env.ROOSTER_ROADMAP_ORG_SLUG && env.ROOSTER_ROADMAP_PROJECT_KEY
      ? {
          orgSlug: env.ROOSTER_ROADMAP_ORG_SLUG,
          projectKey: env.ROOSTER_ROADMAP_PROJECT_KEY.toUpperCase(),
          title: env.ROOSTER_ROADMAP_TITLE,
        }
      : undefined

  // Embeddings need both an endpoint and a key to call out; requiring both
  // together avoids a half-configured provider that silently no-ops.
  if (Boolean(env.ROOSTER_EMBEDDING_URL) !== Boolean(env.ROOSTER_EMBEDDING_API_KEY)) {
    throw new Error(
      'Invalid Rooster environment configuration:\n  - ROOSTER_EMBEDDING_URL and ROOSTER_EMBEDDING_API_KEY must be set together',
    )
  }
  const embedding =
    env.ROOSTER_EMBEDDING_URL && env.ROOSTER_EMBEDDING_API_KEY
      ? {
          url: env.ROOSTER_EMBEDDING_URL,
          apiKey: env.ROOSTER_EMBEDDING_API_KEY,
          model: env.ROOSTER_EMBEDDING_MODEL ?? 'text-embedding-3-small',
        }
      : undefined

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
    roadmap,
    notifications: {
      crowWebhookUrl: env.ROOSTER_CROW_WEBHOOK_URL,
      emailWebhookUrl: env.ROOSTER_EMAIL_WEBHOOK_URL,
      emailResendApiKey: env.RESEND_API_KEY,
      emailFrom: env.ROOSTER_EMAIL_FROM,
    },
    embedding,
  }
}
