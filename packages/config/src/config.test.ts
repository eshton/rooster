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
})
