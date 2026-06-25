import { type ActorIdentity, ForbiddenError, type ProvisionalIdentity } from '@rooster/core'
import type { Repositories } from '@rooster/db'
import type { ClientInfo } from '@rooster/schema'
import type { RoosterAuth } from './auth.js'
import { effectiveScopes, parseScopes } from './scopes.js'

/** The token fields the identity bridge consumes (subset of OAuthAccessToken). */
export interface AccessTokenClaims {
  clientId: string
  /** Space-delimited granted scopes. */
  scopes: string
}

/**
 * Map a validated MCP access token to its bound Agent's trusted
 * {@link ActorIdentity}, or `null` when no agent is bound to the token's
 * `clientId`. A bound-but-suspended agent is refused outright. The effective
 * scopes are the intersection of the token's grant and the agent's configured
 * scopes. `clientInfo` is the untrusted MCP snapshot, carried for audit only.
 */
export async function agentIdentityFromToken(
  repos: Repositories,
  token: AccessTokenClaims,
  clientInfo?: ClientInfo | null,
): Promise<ActorIdentity | null> {
  const agent = await repos.agents.getByOAuthClientId(token.clientId)
  if (!agent) return null
  if (agent.status !== 'active') {
    throw new ForbiddenError(`Agent ${agent.id} is ${agent.status}`)
  }

  return {
    orgId: agent.orgId,
    principalId: agent.principalId,
    scopes: effectiveScopes(parseScopes(token.scopes), agent.scopes),
    clientInfo: clientInfo ?? null,
  }
}

/**
 * Resolve an MCP request's bearer token (via better-auth) into a trusted
 * identity. Ownership is anchored on the better-auth *account* (`userId`), so
 * every OAuth client of the same human maps to the same tenant:
 *
 *  1. No valid MCP session → `null` (the transport answers 401 + challenge).
 *  2. The account is linked to a Rooster user with a principal → a full
 *     {@link ActorIdentity} acting as that human (role from memberships). An
 *     email-created user (e.g. via the dashboard) is lazily linked here.
 *  3. Otherwise, if the token's client is bound to an Agent → that agent's
 *     identity (the headless/service path).
 *  4. Otherwise → a {@link ProvisionalIdentity}: authenticated but orgless, may
 *     only bootstrap a tenant.
 */
export async function resolveMcpIdentity(
  auth: RoosterAuth,
  repos: Repositories,
  headers: Headers,
  clientInfo?: ClientInfo | null,
): Promise<ActorIdentity | ProvisionalIdentity | null> {
  const account = await auth.api.getMcpUser({ headers })
  if (!account) return null

  // (2) Account-anchored human. Prefer the explicit account link; fall back to
  // an email match and backfill the link so later calls resolve directly.
  let user = await repos.users.getByAuthUserId(account.id)
  if (!user && account.email) {
    const byEmail = await repos.users.getByEmail(account.email)
    if (byEmail) user = await repos.users.linkAuthUserId(byEmail.id, account.id)
  }
  if (user) {
    const principal = await repos.principals.findById(user.principalId)
    if (principal) {
      return {
        orgId: principal.orgId,
        principalId: user.principalId,
        clientInfo: clientInfo ?? null,
      }
    }
  }

  // (3) Headless/service agent bound 1:1 to this OAuth client.
  const agent = await agentIdentityFromToken(
    repos,
    { clientId: account.clientId, scopes: account.scopes },
    clientInfo,
  )
  if (agent) return agent

  // (4) Authenticated but not yet a member of any tenant.
  return {
    kind: 'provisional',
    authUserId: account.id,
    email: account.email,
    name: account.name,
    scopes: parseScopes(account.scopes),
    clientInfo: clientInfo ?? null,
  }
}

/**
 * Resolve an authenticated human (by email, from a better-auth session) into an
 * {@link ActorIdentity} within a given org. The org context is supplied by the
 * dashboard; membership in that org is verified here.
 */
export async function humanIdentityFromEmail(
  repos: Repositories,
  orgId: string,
  email: string,
): Promise<ActorIdentity> {
  const user = await repos.users.getByEmail(email)
  if (!user) throw new ForbiddenError(`No Rooster user for '${email}'`)

  const principal = await repos.principals.getById(orgId, user.principalId)
  if (!principal) throw new ForbiddenError('User is not a member of this org')

  return { orgId, principalId: user.principalId }
}

/**
 * Resolve a logged-in human into their {@link ActorIdentity} by email alone,
 * discovering their org (each user maps to a single principal → one org).
 * Returns `null` when the email has no Rooster user/principal yet (signed in
 * but not onboarded into any org). Used by the dashboard session middleware.
 */
export async function humanIdentityFromSessionEmail(
  repos: Repositories,
  email: string,
): Promise<ActorIdentity | null> {
  const user = await repos.users.getByEmail(email)
  if (!user) return null
  const principal = await repos.principals.findById(user.principalId)
  if (!principal) return null
  return { orgId: principal.orgId, principalId: user.principalId }
}
