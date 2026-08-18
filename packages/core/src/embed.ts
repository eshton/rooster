import type { EmbeddingChunkInput, Repositories } from '@rooster/db'
import { type ChunkConfig, chunkText, DEFAULT_CHUNK_CONFIG } from './chunk.js'
import type { Embedder } from './notify.js'

/**
 * Chunk each item's text, embed every chunk in a single batch call, and replace
 * the item's stored chunk-embeddings. Shared by tickets / context files /
 * conversation messages so chunking + storage stay identical across sources.
 *
 * Best-effort by contract: callers wrap it so a failure never breaks the write —
 * the row is simply left un-embedded until a backfill. A no-op when no embedder
 * is configured or nothing has embeddable text.
 */
export async function embedAndStore(
  repos: Repositories,
  embedder: Embedder | undefined,
  chunkConfig: ChunkConfig | undefined,
  orgId: string,
  sourceType: string,
  items: Array<{ id: string; text: string }>,
): Promise<void> {
  if (!embedder || items.length === 0) return
  const cfg = chunkConfig ?? DEFAULT_CHUNK_CONFIG

  // Flatten every item's chunks into one list so all embeddings go in one call.
  const flat: Array<{ itemIdx: number; input: EmbeddingChunkInput; text: string }> = []
  items.forEach((item, itemIdx) => {
    for (const c of chunkText(item.text, cfg)) {
      flat.push({
        itemIdx,
        text: c.text,
        input: { chunkIndex: c.index, vector: [], charStart: c.charStart, charEnd: c.charEnd },
      })
    }
  })
  if (flat.length === 0) return

  const vecs = await embedder.embed(flat.map((f) => f.text))

  const perItem = new Map<number, EmbeddingChunkInput[]>()
  flat.forEach((f, k) => {
    const vec = vecs[k]
    if (!vec) return
    const arr = perItem.get(f.itemIdx) ?? []
    arr.push({ ...f.input, vector: vec })
    perItem.set(f.itemIdx, arr)
  })

  for (const [itemIdx, chunks] of perItem) {
    const item = items[itemIdx]
    if (item && chunks.length > 0) {
      await repos.embeddings.upsertChunks(orgId, sourceType, item.id, chunks, embedder.model)
    }
  }
}
