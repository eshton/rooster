/**
 * Deterministic text chunking for embeddings/RAG. Char-based (no tokenizer
 * dependency — portable across every deploy target and stable across runs);
 * `size`/`overlap` are character counts, a rough proxy for tokens (~4 chars/token).
 * Long bodies become several overlapping windows so retrieval can point at the
 * relevant passage instead of one vector for the whole document (ROO-36).
 */

export interface ChunkConfig {
  /** Target chunk length in characters. */
  size: number
  /** Characters shared between adjacent chunks (must be < size). */
  overlap: number
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = { size: 1200, overlap: 200 }

export interface Chunk {
  /** 0-based position of this chunk within its source. */
  index: number
  text: string
  /** Character offsets into the original text (for later snippet/citation use). */
  charStart: number
  charEnd: number
}

/**
 * Split `text` into overlapping chunks. Text at or under `size` yields a single
 * chunk; empty/whitespace-only text yields none. Cuts prefer a whitespace
 * boundary in the back half of the window to avoid splitting mid-word.
 */
export function chunkText(text: string, cfg: ChunkConfig = DEFAULT_CHUNK_CONFIG): Chunk[] {
  const clean = text ?? ''
  if (clean.trim().length === 0) return []

  const size = Math.max(1, Math.floor(cfg.size))
  const overlap = Math.min(Math.max(0, Math.floor(cfg.overlap)), size - 1)
  if (clean.length <= size) {
    return [{ index: 0, text: clean, charStart: 0, charEnd: clean.length }]
  }

  const chunks: Chunk[] = []
  let start = 0
  let index = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    // Prefer to end on whitespace when not at the very end of the text.
    if (end < clean.length) {
      const ws = clean.lastIndexOf(' ', end)
      if (ws > start + Math.floor(size / 2)) end = ws
    }
    const piece = clean.slice(start, end)
    if (piece.trim().length > 0) {
      chunks.push({ index: index++, text: piece, charStart: start, charEnd: end })
    }
    if (end >= clean.length) break
    // Advance with overlap; guarantee forward progress even if a boundary hugged `start`.
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}
