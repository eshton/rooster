import type { Repositories } from '@rooster/db'
import type { Agent } from '@rooster/schema'
import { describe, expect, it, vi } from 'vitest'
import { bindAgentToOAuthClient } from './provisioning.js'

describe('bindAgentToOAuthClient', () => {
  it('binds the OAuth clientId onto the agent via the repo and returns it', async () => {
    const bound = { id: 'a1', orgId: 'o1', oauthClientId: 'client-123' } as unknown as Agent
    const update = vi.fn().mockResolvedValue(bound)
    const repos = { agents: { update } } as unknown as Repositories

    const result = await bindAgentToOAuthClient(repos, 'o1', 'a1', 'client-123')

    expect(update).toHaveBeenCalledWith('o1', 'a1', { oauthClientId: 'client-123' })
    expect(result).toBe(bound)
  })
})
