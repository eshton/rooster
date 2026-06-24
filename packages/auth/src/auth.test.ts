import { loadConfig } from '@rooster/config'
import { ForbiddenError } from '@rooster/core'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth } from './auth.js'
import { decideEnrollment } from './enrollment.js'
import { agentIdentityFromToken, humanIdentityFromEmail, resolveMcpIdentity } from './identity.js'
import { memoryAdapter } from './index.js'
import { effectiveScopes, parseScopes } from './scopes.js'

const config = loadConfig({
  DATABASE_URL: 'file::memory:',
  ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
  ROOSTER_BASE_URL: 'http://localhost:3000',
})

// --- pure: enrollment gating ------------------------------------------------

describe('decideEnrollment', () => {
  it('admits under open policy', () => {
    expect(decideEnrollment({ policy: 'open' })).toMatchObject({
      outcome: 'admit',
      initialStatus: 'active',
    })
  })

  it('parks approval-policy agents as suspended', () => {
    expect(decideEnrollment({ policy: 'approval' })).toMatchObject({
      outcome: 'pending',
      initialStatus: 'suspended',
    })
  })

  it('requires a matching token under token policy', () => {
    expect(
      decideEnrollment({ policy: 'token', providedToken: 's3cret', expectedToken: 's3cret' }),
    ).toMatchObject({ outcome: 'admit', initialStatus: 'active' })
    expect(
      decideEnrollment({ policy: 'token', providedToken: 'wrong', expectedToken: 's3cret' }),
    ).toMatchObject({ outcome: 'reject', initialStatus: null })
    expect(decideEnrollment({ policy: 'token', providedToken: 's3cret' })).toMatchObject({
      outcome: 'reject',
    })
  })
})

// --- pure: scopes -----------------------------------------------------------

describe('scopes', () => {
  it('parses and dedupes space-delimited scopes', () => {
    expect(parseScopes('ticket:read  ticket:write ticket:read')).toEqual([
      'ticket:read',
      'ticket:write',
    ])
    expect(parseScopes('')).toEqual([])
    expect(parseScopes(null)).toEqual([])
  })

  it('intersects token scopes with the agent allowance', () => {
    expect(effectiveScopes(['ticket:read', 'ticket:write'], ['ticket:read'])).toEqual([
      'ticket:read',
    ])
    expect(effectiveScopes(['ticket:read'], ['*'])).toEqual(['ticket:read'])
    expect(effectiveScopes(['*'], ['ticket:read'])).toEqual(['ticket:read'])
  })
})

// --- identity bridge --------------------------------------------------------

describe('identity bridge', () => {
  let db: Database

  beforeEach(async () => {
    db = await createDatabase(config, { migrate: true })
  })
  afterEach(async () => {
    await db.close()
  })

  async function seedAgent(opts: {
    clientId: string
    scopes: string[]
    status: 'active' | 'suspended'
  }) {
    const org = await db.repositories.orgs.create({
      slug: 'acme',
      name: 'Acme',
      enrollmentPolicy: 'token',
    })
    const principal = await db.repositories.principals.create(org.id, {
      type: 'agent',
      displayName: 'A',
    })
    const agent = await db.repositories.agents.create(org.id, {
      principalId: principal.id,
      ownerUserId: principal.id,
      displayName: 'A',
      kind: 'claude-code',
      vendor: null,
      version: null,
      oauthClientId: opts.clientId,
      scopes: opts.scopes,
      status: opts.status,
    })
    return { org, principal, agent }
  }

  it('maps an access token to the bound agent identity, intersecting scopes', async () => {
    const { org, principal } = await seedAgent({
      clientId: 'client-1',
      scopes: ['ticket:read', 'ticket:write'],
      status: 'active',
    })
    const identity = await agentIdentityFromToken(
      db.repositories,
      { clientId: 'client-1', scopes: 'ticket:read ticket:write audit:read' },
      { name: 'Claude Code', version: '1.0' },
    )
    expect(identity.orgId).toBe(org.id)
    expect(identity.principalId).toBe(principal.id)
    // audit:read is not in the agent's allowance, so it is dropped.
    expect(identity.scopes).toEqual(['ticket:read', 'ticket:write'])
    expect(identity.clientInfo).toEqual({ name: 'Claude Code', version: '1.0' })
  })

  it('refuses unknown clients and non-active agents', async () => {
    await seedAgent({ clientId: 'client-2', scopes: ['ticket:read'], status: 'suspended' })
    await expect(
      agentIdentityFromToken(db.repositories, { clientId: 'nope', scopes: '' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      agentIdentityFromToken(db.repositories, { clientId: 'client-2', scopes: 'ticket:read' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('resolveMcpIdentity returns null without a session', async () => {
    const fakeAuth = { api: { getMcpSession: async () => null } } as never
    expect(await resolveMcpIdentity(fakeAuth, db.repositories, new Headers())).toBeNull()
  })

  it('maps a human email to an org-scoped identity', async () => {
    const org = await db.repositories.orgs.create({
      slug: 'acme',
      name: 'Acme',
      enrollmentPolicy: 'open',
    })
    const principal = await db.repositories.principals.create(org.id, {
      type: 'user',
      displayName: 'Ada',
    })
    await db.repositories.users.create({
      principalId: principal.id,
      email: 'ada@acme.test',
      name: 'Ada',
      avatarUrl: null,
    })

    const identity = await humanIdentityFromEmail(db.repositories, org.id, 'ada@acme.test')
    expect(identity.principalId).toBe(principal.id)

    await expect(
      humanIdentityFromEmail(db.repositories, 'other-org-id', 'ada@acme.test'),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })
})

// --- real OAuth 2.1 server (memory adapter) ---------------------------------

describe('MCP OAuth server', () => {
  const auth = createAuth({ config, database: memoryAdapter({}) })
  const base = `${config.baseUrl}/api/auth`

  it('advertises a PKCE-required AS with dynamic registration', async () => {
    const res = await auth.handler(new Request(`${base}/.well-known/oauth-authorization-server`))
    expect(res.status).toBe(200)
    const meta = (await res.json()) as Record<string, unknown>
    expect(meta.registration_endpoint).toBeTruthy()
    expect(meta.code_challenge_methods_supported).toContain('S256')
    expect(meta.token_endpoint).toBeTruthy()
  })

  it('supports Dynamic Client Registration', async () => {
    const res = await auth.handler(
      new Request(`${base}/mcp/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test Agent',
          redirect_uris: ['http://localhost:9999/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    )
    expect([200, 201]).toContain(res.status)
    const client = (await res.json()) as Record<string, unknown>
    expect(client.client_id).toBeTruthy()
  })
})
