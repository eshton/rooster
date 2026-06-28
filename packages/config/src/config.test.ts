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

  it('groups the additional OAuth providers the same way', () => {
    const cfg = loadConfig({
      ...baseEnv,
      DISCORD_CLIENT_ID: 'd-id',
      DISCORD_CLIENT_SECRET: 'd-secret',
      GITLAB_CLIENT_ID: 'gl-id',
      GITLAB_CLIENT_SECRET: 'gl-secret',
    })
    expect(cfg.oauthProviders.discord).toEqual({ clientId: 'd-id', clientSecret: 'd-secret' })
    expect(cfg.oauthProviders.gitlab).toEqual({ clientId: 'gl-id', clientSecret: 'gl-secret' })
    // A provider with only half its credentials is not enabled.
    expect(cfg.oauthProviders.microsoft).toBeUndefined()
    expect(loadConfig({ ...baseEnv, APPLE_CLIENT_ID: 'a-id' }).oauthProviders.apple).toBeUndefined()
  })

  it('parses ROOSTER_REQUIRE_EMAIL_VERIFICATION as a boolean (default false)', () => {
    expect(loadConfig(baseEnv).requireEmailVerification).toBe(false)
    expect(
      loadConfig({ ...baseEnv, ROOSTER_REQUIRE_EMAIL_VERIFICATION: 'true' })
        .requireEmailVerification,
    ).toBe(true)
    expect(
      loadConfig({ ...baseEnv, ROOSTER_REQUIRE_EMAIL_VERIFICATION: '1' }).requireEmailVerification,
    ).toBe(true)
    expect(
      loadConfig({ ...baseEnv, ROOSTER_REQUIRE_EMAIL_VERIFICATION: 'false' })
        .requireEmailVerification,
    ).toBe(false)
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
})
