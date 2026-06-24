import { describe, expect, it } from 'vitest'
import { createTicketInput, ROLES, roleRank, ticketKeySchema, ticketStatusSchema } from './index.js'

describe('enums', () => {
  it('orders roles by privilege', () => {
    const ranks = ROLES.map((r) => roleRank[r])
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(roleRank.owner).toBeGreaterThan(roleRank.viewer)
  })

  it('rejects unknown ticket statuses', () => {
    expect(ticketStatusSchema.safeParse('done').success).toBe(true)
    expect(ticketStatusSchema.safeParse('shipped').success).toBe(false)
  })
})

describe('ticketKeySchema', () => {
  it('accepts well-formed keys', () => {
    expect(ticketKeySchema.safeParse('ROOST-42').success).toBe(true)
  })

  it('rejects malformed keys', () => {
    for (const bad of ['roost-42', 'ROOST', 'ROOST-', '-42', 'R-1']) {
      expect(ticketKeySchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('createTicketInput', () => {
  it('applies defaults for priority and labels', () => {
    const parsed = createTicketInput.parse({
      projectId: '00000000-0000-4000-8000-000000000000',
      title: 'Wire up the coop',
    })
    expect(parsed.priority).toBe('none')
    expect(parsed.labels).toEqual([])
  })

  it('requires a non-empty title', () => {
    const result = createTicketInput.safeParse({
      projectId: '00000000-0000-4000-8000-000000000000',
      title: '',
    })
    expect(result.success).toBe(false)
  })
})
