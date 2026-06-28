import { type Role, roleRank } from '@rooster/schema'
import type { Actor } from './actor.js'
import { ForbiddenError } from './errors.js'

/**
 * Coarse-grained permissions. Each maps to a minimum membership role and — for
 * agent principals — a matching token scope string. Authorization is defense in
 * depth: an agent needs BOTH a sufficient role (via membership) AND the scope
 * (via its OAuth token); a human is governed by role alone.
 */
export type Permission =
  | 'ticket:read'
  | 'ticket:write'
  | 'project:write'
  | 'team:write'
  | 'agent:read'
  | 'agent:write'
  | 'audit:read'
  | 'conversation:read'
  | 'conversation:write'

export const PERMISSION_MIN_ROLE: Record<Permission, Role> = {
  'ticket:read': 'viewer',
  'ticket:write': 'member',
  'project:write': 'member',
  'team:write': 'admin',
  'agent:read': 'viewer',
  'agent:write': 'admin',
  'audit:read': 'admin',
  // Conversation transcripts are more sensitive than ticket metadata, so they
  // are NOT covered by ticket:read/write — they get their own scope. Reading is
  // member+ (not viewer) so a low-trust principal can browse the board without
  // seeing raw human↔agent transcripts.
  'conversation:read': 'member',
  'conversation:write': 'member',
}

/** A token scope grants a permission directly, or via the `*` wildcard. */
export function hasScope(scopes: readonly string[], permission: Permission): boolean {
  return scopes.includes('*') || scopes.includes(permission)
}

/** True if the actor satisfies both the role floor and (for agents) the scope. */
export function can(actor: Actor, permission: Permission): boolean {
  if (roleRank[actor.role] < roleRank[PERMISSION_MIN_ROLE[permission]]) return false
  if (actor.type === 'agent' && !hasScope(actor.scopes, permission)) return false
  return true
}

/** Throw {@link ForbiddenError} unless the actor holds the permission. */
export function authorize(actor: Actor, permission: Permission): void {
  if (can(actor, permission)) return
  const reason =
    roleRank[actor.role] < roleRank[PERMISSION_MIN_ROLE[permission]]
      ? `role '${actor.role}' is below required '${PERMISSION_MIN_ROLE[permission]}'`
      : `token is missing scope '${permission}'`
  throw new ForbiddenError(`Not permitted to '${permission}': ${reason}`)
}
