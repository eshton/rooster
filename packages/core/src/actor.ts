import type { Repositories } from '@rooster/db'
import { type ClientInfo, type Id, type PrincipalType, type Role, roleRank } from '@rooster/schema'
import { ForbiddenError } from './errors.js'

/**
 * The authenticated caller of a core service. The trusted identity is
 * `principalId` (resolved from a session cookie or an OAuth token). `role` is
 * the effective org role; `scopes` are the agent token's scopes (empty for
 * humans). `clientInfo` is the untrusted, self-reported MCP client snapshot —
 * carried only into the audit log, never into authorization.
 */
export interface Actor {
  readonly orgId: Id
  readonly principalId: Id
  readonly type: PrincipalType
  readonly role: Role
  readonly scopes: readonly string[]
  readonly clientInfo?: ClientInfo | null
}

/** The trusted identity a transport hands to {@link resolveActor}. */
export interface ActorIdentity {
  orgId: Id
  principalId: Id
  /** Agent token scopes; ignored for human principals. */
  scopes?: readonly string[]
  clientInfo?: ClientInfo | null
}

/**
 * An authenticated caller who is anchored to a verified account but does not yet
 * belong to any org. They may only bootstrap a tenant (`create_tenant`) or read
 * their own identity (`whoami`) — never act on tenant data. Carries the
 * better-auth account fields needed to provision the founding user.
 */
export interface ProvisionalIdentity {
  kind: 'provisional'
  /** Stable better-auth account id; becomes the new user's `authUserId`. */
  authUserId: string
  email: string
  name: string
  scopes?: readonly string[]
  clientInfo?: ClientInfo | null
}

/** Narrow a resolved MCP identity to the orgless, tenant-bootstrap-only case. */
export function isProvisional(
  identity: ActorIdentity | ProvisionalIdentity,
): identity is ProvisionalIdentity {
  return 'kind' in identity && identity.kind === 'provisional'
}

/**
 * Resolve a trusted identity into an {@link Actor}, computing the effective org
 * role as the highest role across the principal's memberships in that org. A
 * principal with no membership in the org cannot act there.
 */
export async function resolveActor(repos: Repositories, identity: ActorIdentity): Promise<Actor> {
  const principal = await repos.principals.getById(identity.orgId, identity.principalId)
  if (!principal) {
    throw new ForbiddenError('Principal is not a member of this org')
  }

  const memberships = await repos.memberships.list(identity.orgId, identity.principalId)
  if (memberships.length === 0) {
    throw new ForbiddenError('Principal has no membership in this org')
  }
  const role = memberships.reduce<Role>(
    (best, m) => (roleRank[m.role] > roleRank[best] ? m.role : best),
    'viewer',
  )

  return {
    orgId: identity.orgId,
    principalId: identity.principalId,
    type: principal.type,
    role,
    scopes: identity.scopes ?? [],
    clientInfo: identity.clientInfo ?? null,
  }
}
