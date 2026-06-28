import { describe, expect, it } from 'vitest'
import { detectPlatform, loadConfig, resolveDbKind } from './index.js'

const baseEnv = {
  DATABASE_URL: 'file:./local.db',
  ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
}

describe('resolveDbKind', () => {
  it('maps schemes to driver kinds', () => {
    expect(resolveDbKind('postgres://u:p@h/db')).toBe('postgres')
    expect(resolveDbKind('postgresql://u:p@h/db')).toBe('postgres')
    expect(resolveDbKind('file:./local.db')).toBe('sqlite')
    expect(resolveDbKind('libsql://x.turso.io')).toBe('libsql')
  })

  it('throws on an unknown scheme', () => {
    expect(() => resolveDbKind('mysql://h/db')).toThrow(/Unsupported DATABASE_URL/)
  })
})

describe('detectPlatform', () => {
  it('defaults to node', () => {
    expect(detectPlatform({})).toBe('node')
  })

  it('honors an explicit override', () => {
    expect(detectPlatform({ ROOSTER_PLATFORM: 'cloudflare' })).toBe('cloudflare')
  })

  it('detects vercel from env', () => {
    expect(detectPlatform({ VERCEL: '1' })).toBe('vercel')
  })
})

describe('loadConfig', () => {
  it('derives db kind and trims a trailing slash from base url', () => {
    const cfg = loadConfig({ ...baseEnv, ROOSTER_BASE_URL: 'https://rooster.example/' })
    expect(cfg.database.kind).toBe('sqlite')
    expect(cfg.baseUrl).toBe('https://rooster.example')
    expect(cfg.enrollment.policy).toBe('token')
  })

  it('groups OAuth provider id+secret into a provider object', () => {
    const cfg = loadConfig({
      ...baseEnv,
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-secret',
    })
    expect(cfg.oauthProviders.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' })
    expect(cfg.oauthProviders.google).toBeUndefined()
  })

  it('rejects a too-short auth secret with a readable error', () => {
    expect(() => loadConfig({ ...baseEnv, ROOSTER_AUTH_SECRET: 'short' })).toThrow(
      /ROOSTER_AUTH_SECRET/,
    )
  })

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({ ROOSTER_AUTH_SECRET: baseEnv.ROOSTER_AUTH_SECRET })).toThrow(
      /environment configuration/,
    )
  })

  it('parses ROOSTER_DISABLE_SIGNUP as a boolean (default false)', () => {
    expect(loadConfig(baseEnv).onboarding.disableSignup).toBe(false)
    expect(
      loadConfig({ ...baseEnv, ROOSTER_DISABLE_SIGNUP: 'true' }).onboarding.disableSignup,
    ).toBe(true)
    expect(loadConfig({ ...baseEnv, ROOSTER_DISABLE_SIGNUP: '1' }).onboarding.disableSignup).toBe(
      true,
    )
    // Any other value (incl. "false") is falsey — no accidental opt-in.
    expect(
      loadConfig({ ...baseEnv, ROOSTER_DISABLE_SIGNUP: 'false' }).onboarding.disableSignup,
    ).toBe(false)
  })

  it('builds the admin bootstrap config with defaults, all-or-nothing', () => {
    expect(loadConfig(baseEnv).admin).toBeUndefined()
    const cfg = loadConfig({
      ...baseEnv,
      ROOSTER_ADMIN_EMAIL: 'admin@acme.test',
      ROOSTER_ADMIN_PASSWORD: 'supersecret',
    })
    expect(cfg.admin).toEqual({
      email: 'admin@acme.test',
      password: 'supersecret',
      workspace: 'My Workspace',
      projectKey: 'TASK',
    })
    // Only one of the pair set → readable error.
    expect(() => loadConfig({ ...baseEnv, ROOSTER_ADMIN_EMAIL: 'admin@acme.test' })).toThrow(
      /ROOSTER_ADMIN_EMAIL and ROOSTER_ADMIN_PASSWORD/,
    )
  })

  it('builds the public roadmap config all-or-nothing, upper-casing the key', () => {
    expect(loadConfig(baseEnv).roadmap).toBeUndefined()
    const cfg = loadConfig({
      ...baseEnv,
      ROOSTER_ROADMAP_ORG_SLUG: 'rooster-dev',
      ROOSTER_ROADMAP_PROJECT_KEY: 'roo',
      ROOSTER_ROADMAP_TITLE: 'Rooster roadmap',
    })
    expect(cfg.roadmap).toEqual({
      orgSlug: 'rooster-dev',
      projectKey: 'ROO',
      title: 'Rooster roadmap',
    })
    // Only one of the pair set → readable error.
    expect(() => loadConfig({ ...baseEnv, ROOSTER_ROADMAP_ORG_SLUG: 'rooster-dev' })).toThrow(
      /ROOSTER_ROADMAP_ORG_SLUG and ROOSTER_ROADMAP_PROJECT_KEY/,
    )
  })

  it('builds the embedding config all-or-nothing, defaulting the model', () => {
    expect(loadConfig(baseEnv).embedding).toBeUndefined()
    const cfg = loadConfig({
      ...baseEnv,
      ROOSTER_EMBEDDING_URL: 'https://api.openai.com/v1/embeddings',
      ROOSTER_EMBEDDING_API_KEY: 'sk-test',
    })
    expect(cfg.embedding).toEqual({
      url: 'https://api.openai.com/v1/embeddings',
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
    })
    // Only one of the pair set → readable error.
    expect(() =>
      loadConfig({ ...baseEnv, ROOSTER_EMBEDDING_URL: 'https://api.openai.com/v1/embeddings' }),
    ).toThrow(/ROOSTER_EMBEDDING_URL and ROOSTER_EMBEDDING_API_KEY/)
  })

  it('defaults embeddingDims to 1536 and coerces an override', () => {
    // Always present — it sizes the embeddings table even with no embedder.
    expect(loadConfig(baseEnv).embeddingDims).toBe(1536)
    expect(loadConfig({ ...baseEnv, ROOSTER_EMBEDDING_DIMS: '1024' }).embeddingDims).toBe(1024)
    expect(() => loadConfig({ ...baseEnv, ROOSTER_EMBEDDING_DIMS: '0' })).toThrow(
      /Invalid Rooster environment configuration/,
    )
  })
})
