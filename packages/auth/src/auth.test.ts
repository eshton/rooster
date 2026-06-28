import { loadConfig } from '@rooster/config'
import { ForbiddenError } from '@rooster/core'
import { createDatabase, type Database } from '@rooster/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuth, type EmailMessage } from './auth.js'
import { decideEnrollment } from './enrollment.js'
import {
  agentIdentityFromToken,
  humanIdentityFromEmail,
  humanIdentityFromSessionEmail,
  listUserOrgs,
  resolveMcpIdentity,
} from './identity.js'
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
    expect(identity).not.toBeNull()
    expect(identity?.orgId).toBe(org.id)
    expect(identity?.principalId).toBe(principal.id)
    // audit:read is not in the agent's allowance, so it is dropped.
    expect(identity?.scopes).toEqual(['ticket:read', 'ticket:write'])
    expect(identity?.clientInfo).toEqual({ name: 'Claude Code', version: '1.0' })
  })

  it('returns null for unknown clients and refuses non-active agents', async () => {
    await seedAgent({ clientId: 'client-2', scopes: ['ticket:read'], status: 'suspended' })
    // No agent bound to this client → null (lets the caller fall through to the
    // account-anchored / provisional path).
    expect(
      await agentIdentityFromToken(db.repositories, { clientId: 'nope', scopes: '' }),
    ).toBeNull()
    // Bound but suspended → hard refusal.
    await expect(
      agentIdentityFromToken(db.repositories, { clientId: 'client-2', scopes: 'ticket:read' }),
    ).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('resolveMcpIdentity returns null without a session', async () => {
    const fakeAuth = { api: { getMcpUser: async () => null } } as never
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

  it('resolves a multi-org account to the active workspace and lists all of them', async () => {
    // One account (same email) with a principal in two orgs, linked via userId.
    const orgA = await db.repositories.orgs.create({
      slug: 'a',
      name: 'A',
      enrollmentPolicy: 'open',
    })
    const orgB = await db.repositories.orgs.create({
      slug: 'b',
      name: 'B',
      enrollmentPolicy: 'open',
    })
    const pA = await db.repositories.principals.create(orgA.id, {
      type: 'user',
      displayName: 'Ada',
    })
    const user = await db.repositories.users.create({
      principalId: pA.id,
      email: 'ada@multi.test',
      name: 'Ada',
      avatarUrl: null,
    })
    await db.repositories.principals.linkUser(orgA.id, pA.id, user.id)
    const pB = await db.repositories.principals.create(orgB.id, {
      type: 'user',
      displayName: 'Ada',
      userId: user.id,
    })

    const orgs = await listUserOrgs(db.repositories, 'ada@multi.test')
    expect(orgs.map((o) => o.orgId).sort()).toEqual([orgA.id, orgB.id].sort())

    // Default (no active org) resolves to the home principal's org.
    const home = await humanIdentityFromSessionEmail(db.repositories, 'ada@multi.test')
    expect(home?.orgId).toBe(orgA.id)
    expect(home?.principalId).toBe(pA.id)

    // Pinning org B selects that principal.
    const inB = await humanIdentityFromSessionEmail(db.repositories, 'ada@multi.test', orgB.id)
    expect(inB?.orgId).toBe(orgB.id)
    expect(inB?.principalId).toBe(pB.id)

    // An org the user doesn't belong to falls back to home.
    const fallback = await humanIdentityFromSessionEmail(db.repositories, 'ada@multi.test', 'nope')
    expect(fallback?.orgId).toBe(orgA.id)
  })

  it('resolveMcpIdentity selects the workspace from the desired org (X-Rooster-Org)', async () => {
    const orgA = await db.repositories.orgs.create({
      slug: 'ma',
      name: 'MA',
      enrollmentPolicy: 'open',
    })
    const orgB = await db.repositories.orgs.create({
      slug: 'mb',
      name: 'MB',
      enrollmentPolicy: 'open',
    })
    const pA = await db.repositories.principals.create(orgA.id, {
      type: 'user',
      displayName: 'Ada',
    })
    const user = await db.repositories.users.create({
      principalId: pA.id,
      email: 'ada@mcp.test',
      name: 'Ada',
      avatarUrl: null,
    })
    await db.repositories.principals.linkUser(orgA.id, pA.id, user.id)
    const pB = await db.repositories.principals.create(orgB.id, {
      type: 'user',
      displayName: 'Ada',
      userId: user.id,
    })
    const fakeAuth = {
      api: {
        getMcpUser: async () => ({
          id: 'acct-mcp',
          email: 'ada@mcp.test',
          name: 'Ada',
          clientId: 'c',
          scopes: '',
        }),
      },
    } as never
    const at = (v: unknown) => v as { orgId: string; principalId: string }

    // Default → home org (A).
    expect(at(await resolveMcpIdentity(fakeAuth, db.repositories, new Headers())).orgId).toBe(
      orgA.id,
    )
    // Desired org B → that org's principal.
    const inB = at(
      await resolveMcpIdentity(fakeAuth, db.repositories, new Headers(), null, orgB.id),
    )
    expect(inB.orgId).toBe(orgB.id)
    expect(inB.principalId).toBe(pB.id)
    // Unknown org → falls back to home.
    expect(
      at(await resolveMcpIdentity(fakeAuth, db.repositories, new Headers(), null, 'nope')).orgId,
    ).toBe(orgA.id)
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

// --- transactional email seam (password reset) -----------------------------

describe('email seam', () => {
  it('routes password-reset mail through the supplied sender', async () => {
    const sent: EmailMessage[] = []
    const auth = createAuth({
      config,
      // The memory adapter needs its model tables pre-declared (it doesn't
      // create them on read) for email/password sign-up to work.
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      sendEmail: { send: async (m) => void sent.push(m) },
    })
    const base = `${config.baseUrl}/api/auth`
    const json = { 'content-type': 'application/json' }

    // Register an email/password account, then request a reset link.
    await auth.handler(
      new Request(`${base}/sign-up/email`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ name: 'Ada', email: 'ada@acme.test', password: 'supersecret' }),
      }),
    )
    const res = await auth.handler(
      new Request(`${base}/request-password-reset`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ email: 'ada@acme.test', redirectTo: `${config.baseUrl}/app/reset` }),
      }),
    )
    expect(res.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'ada@acme.test', kind: 'reset-password' })
    // The link is better-auth's reset-password callback (token in the path),
    // which redirects to our `/app/reset-password?token=…` page once visited.
    expect(sent[0]?.url).toContain('/reset-password/')
    expect(sent[0]?.url).toContain('callbackURL=')
  })
})

describe('social providers + email verification', () => {
  const envBase = {
    DATABASE_URL: 'file::memory:',
    ROOSTER_AUTH_SECRET: 'a-sufficiently-long-secret',
    ROOSTER_BASE_URL: 'http://localhost:3000',
  }
  const adapter = () => memoryAdapter({ user: [], session: [], account: [], verification: [] })
  const optionsOf = (auth: ReturnType<typeof createAuth>) =>
    auth.options as {
      socialProviders?: Record<string, unknown>
      emailAndPassword?: { requireEmailVerification?: boolean }
    }

  it('enables exactly the social providers whose credentials are present', () => {
    const config = loadConfig({
      ...envBase,
      GITHUB_CLIENT_ID: 'gh',
      GITHUB_CLIENT_SECRET: 'gh-s',
      DISCORD_CLIENT_ID: 'dc',
      DISCORD_CLIENT_SECRET: 'dc-s',
      GITLAB_CLIENT_ID: 'gl',
      GITLAB_CLIENT_SECRET: 'gl-s',
    })
    const auth = createAuth({ config, database: adapter() })
    expect(Object.keys(optionsOf(auth).socialProviders ?? {}).sort()).toEqual([
      'discord',
      'github',
      'gitlab',
    ])
  })

  it('leaves email verification off unless the flag AND a real sender are set', () => {
    const sender = { send: async () => {} }

    const flagOnly = createAuth({
      config: loadConfig({ ...envBase, ROOSTER_REQUIRE_EMAIL_VERIFICATION: 'true' }),
      database: adapter(),
    })
    expect(optionsOf(flagOnly).emailAndPassword?.requireEmailVerification).toBe(false)

    const senderOnly = createAuth({
      config: loadConfig(envBase),
      database: adapter(),
      sendEmail: sender,
    })
    expect(optionsOf(senderOnly).emailAndPassword?.requireEmailVerification).toBe(false)

    const both = createAuth({
      config: loadConfig({ ...envBase, ROOSTER_REQUIRE_EMAIL_VERIFICATION: 'true' }),
      database: adapter(),
      sendEmail: sender,
    })
    expect(optionsOf(both).emailAndPassword?.requireEmailVerification).toBe(true)
  })

  it('sends a verification email on sign-up when enabled', async () => {
    const sent: EmailMessage[] = []
    const auth = createAuth({
      config: loadConfig({ ...envBase, ROOSTER_REQUIRE_EMAIL_VERIFICATION: 'true' }),
      database: adapter(),
      sendEmail: { send: async (m) => void sent.push(m) },
    })
    await auth.handler(
      new Request(`${envBase.ROOSTER_BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Bo', email: 'bo@acme.test', password: 'supersecret' }),
      }),
    )
    expect(sent.some((m) => m.kind === 'verify-email' && m.to === 'bo@acme.test')).toBe(true)
  })
})
