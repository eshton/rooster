import { describe, expect, it } from 'vitest'
import { reciprocalRankFusion } from './rag.js'

const item = (key: string) => ({ key })

describe('reciprocalRankFusion', () => {
  it('ranks an item appearing high in multiple lists above single-list leaders', () => {
    const listA = [item('a'), item('b'), item('c')] // keyword arm
    const listB = [item('b'), item('d'), item('a')] // vector arm
    const fused = reciprocalRankFusion([listA, listB])
    // b is #1 in B and #2 in A → highest combined; a is #1 in A and #3 in B.
    expect(fused[0].key).toBe('b')
    expect(fused.map((f) => f.key).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('sums contributions and orders by fused score descending', () => {
    const fused = reciprocalRankFusion([[item('x'), item('y')], [item('x')]])
    // x: 1/(60+1) + 1/(60+1); y: 1/(60+2) → x first.
    expect(fused[0].key).toBe('x')
    expect(fused[0].score).toBeGreaterThan(fused[1].score)
  })

  it('handles empty and single lists', () => {
    expect(reciprocalRankFusion([])).toEqual([])
    expect(reciprocalRankFusion([[], []])).toEqual([])
    expect(reciprocalRankFusion([[item('only')]]).map((f) => f.key)).toEqual(['only'])
  })
})
