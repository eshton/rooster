import { describe, expect, it } from 'vitest'
import { chunkText } from './chunk.js'

describe('chunkText', () => {
  it('returns no chunks for empty/whitespace text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\t ')).toEqual([])
  })

  it('returns a single chunk when text fits within size', () => {
    const chunks = chunkText('short body', { size: 100, overlap: 10 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ index: 0, text: 'short body', charStart: 0, charEnd: 10 })
  })

  it('splits long text into overlapping chunks with monotonic indices', () => {
    const text = `${'a'.repeat(50)} ${'b'.repeat(50)} ${'c'.repeat(50)}`
    const chunks = chunkText(text, { size: 60, overlap: 20 })
    expect(chunks.length).toBeGreaterThan(1)
    // indices are 0..n-1 in order
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
    // adjacent chunks overlap: each starts before the previous one ended
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeLessThan(chunks[i - 1].charEnd)
      expect(chunks[i].charStart).toBeGreaterThan(chunks[i - 1].charStart)
    }
    // offsets reconstruct the slice
    for (const c of chunks) expect(c.text).toBe(text.slice(c.charStart, c.charEnd))
    // full coverage: the last chunk reaches the end
    expect(chunks[chunks.length - 1].charEnd).toBe(text.length)
  })

  it('makes forward progress even with large overlap', () => {
    const text = 'x'.repeat(1000)
    const chunks = chunkText(text, { size: 100, overlap: 90 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[chunks.length - 1].charEnd).toBe(1000)
  })
})
