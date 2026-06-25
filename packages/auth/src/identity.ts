import { type ActorIdentity, ForbiddenError } from '@rooster/core'
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
 * Map a validated MCP access token to a trusted {@link ActorIdentity}. The
 * token's `clientId` is resolved to its bound Agent (the trusted identity); the
 * effective scopes are the intersection of the token's grant and the agent's
 * configured scopes. Revoked/suspended agents are refused. `clientInfo` is the
 * untrusted, self-reported MCP snapshot, carried through for the audit log only.
 */
export async function agentIdentityFromToken(
  repos: Repositories,
  token: AccessTokenClaims,
  clientInfo?: ClientInfo | null,
): Promise<ActorIdentity> {
  const agent = await repos.agents.getByOAuthClientId(token.clientId)
  if (!agent) {
    throw new ForbiddenError(`No agent is bound to OAuth client '${token.clientId}'`)
  }
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
 * Resolve an MCP request's bearer token (via better-auth) into an
 * {@link ActorIdentity}. Returns `null` when the request carries no valid MCP
 * session, so the transport can answer with a 401 + WWW-Authenticate challenge.
 */
export async function resolveMcpIdentity(
  auth: RoosterAuth,
  repos: Repositories,
  headers: Headers,
  clientInfo?: ClientInfo | null,
): Promise<ActorIdentity | null> {
  const session = await auth.api.getMcpSession({ headers })
  if (!session) return null
  return agentIdentityFromToken(
    repos,
    { clientId: session.clientId, scopes: session.scopes },
    clientInfo,
  )
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
