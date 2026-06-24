import type { Repositories } from '@rooster/db'
import type { Agent, Id } from '@rooster/schema'

/**
 * Bind an Agent principal to the OAuth client that represents it (1:1). Once
 * bound, {@link agentIdentityFromToken} can resolve a token's `clientId` back to
 * this agent. Called after Dynamic Client Registration issues a client for a
 * registered agent.
 */
export async function bindAgentToOAuthClient(
  repos: Repositories,
  orgId: Id,
  agentId: Id,
  oauthClientId: string,
): Promise<Agent> {
  return repos.agents.update(orgId, agentId, { oauthClientId })
}
