import type { RoosterConfig } from '@rooster/config'
import type { Embedder } from '@rooster/core'

/** Expected dimensionality of stored vectors (the fixed `F32_BLOB(1536)` column). */
const EMBEDDING_DIMS = 1536

interface OpenAiEmbeddingResponse {
  data?: Array<{ embedding: number[]; index: number }>
}

/**
 * Embedder backed by an OpenAI-compatible `/embeddings` HTTP API. A single
 * `fetch` with no Node-only imports, so it runs on Cloudflare Workers as well as
 * Node (keeps the Worker bundle pg-free).
 *
 * Returns `undefined` unless embeddings are configured AND the target DB can
 * store vectors (libSQL/Turso — not the frozen Postgres path), so callers treat
 * semantic search as unconfigured and recall tools report so.
 */
export function embedderFor(config: RoosterConfig): Embedder | undefined {
  const cfg = config.embedding
  if (!cfg) return undefined
  // Vector storage is libSQL-native; Postgres is the frozen path with no vectors.
  if (config.database.kind === 'postgres') return undefined

  return {
    model: cfg.model,
    async embed(texts) {
      if (texts.length === 0) return []
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: cfg.model, input: texts }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Embedding request failed (${res.status}): ${detail.slice(0, 300)}`)
      }
      const json = (await res.json()) as OpenAiEmbeddingResponse
      const data = json.data
      if (!data || data.length !== texts.length) {
        throw new Error(`Embedding response shape unexpected (got ${data?.length ?? 0} vectors)`)
      }
      // Order by `index` so vectors line up with the input texts.
      const sorted = [...data].sort((a, b) => a.index - b.index)
      for (const d of sorted) {
        if (d.embedding.length !== EMBEDDING_DIMS) {
          throw new Error(
            `Embedding model returned ${d.embedding.length} dims; expected ${EMBEDDING_DIMS}. ` +
              'Set ROOSTER_EMBEDDING_MODEL to a 1536-dim model.',
          )
        }
      }
      return sorted.map((d) => d.embedding)
    },
  }
}
