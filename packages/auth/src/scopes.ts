import { PERMISSION_MIN_ROLE, type Permission } from '@rooster/core'

/**
 * OAuth scopes an agent token may carry. They are exactly the core
 * {@link Permission} strings, so a granted scope maps 1:1 to a permission the
 * core layer checks. `*` is the wildcard (all permissions).
 */
export const ROOSTER_SCOPES = Object.keys(PERMISSION_MIN_ROLE) as Permission[]

/** Parse an OAuth scope string (space-delimited) into a deduplicated list. */
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/\s+/).filter(Boolean))]
}

/**
 * Effective scopes for a token = the intersection of what the token was
 * granted and what the agent is configured to allow. A token can never exceed
 * its agent's configured scopes, even if the token string claims more.
 */
export function effectiveScopes(
  tokenScopes: readonly string[],
  agentScopes: readonly string[],
): string[] {
  if (agentScopes.includes('*')) return [...tokenScopes]
  if (tokenScopes.includes('*')) return [...agentScopes]
  const allowed = new Set(agentScopes)
  return tokenScopes.filter((s) => allowed.has(s))
}
