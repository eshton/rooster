import type { RoosterConfig } from '@rooster/config'
import type { Reranker } from '@rooster/core'

/** Cloudflare Workers AI reranker response: `result.response: [{ id, score }]`. */
interface CfRerankResponse {
  result?: { response?: Array<{ id: number; score: number }> }
  response?: Array<{ id: number; score: number }>
}

/**
 * Reranker backed by a Cloudflare Workers AI bge-reranker run endpoint. A single
 * `fetch` with no Node-only imports, so it runs on Workers as well as Node.
 * Request/response follow the Workers AI shape:
 *   POST { query, contexts: [{ text }] } → { result: { response: [{ id, score }] } }
 * where `id` indexes back into `contexts`. Returns `undefined` unless a reranker
 * is configured, so callers keep their fusion order.
 */
export function rerankerFor(config: RoosterConfig): Reranker | undefined {
  const cfg = config.rerank
  if (!cfg) return undefined

  return {
    model: cfg.model,
    async rerank(query, documents) {
      if (documents.length === 0) return []
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query, contexts: documents.map((text) => ({ text })) }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Rerank request failed (${res.status}): ${detail.slice(0, 300)}`)
      }
      const json = (await res.json()) as CfRerankResponse
      const ranked = json.result?.response ?? json.response
      if (!ranked) throw new Error('Rerank response shape unexpected (no result.response)')

      // Map ranked {id, score} back to a score per input document (by index).
      const scores = new Array<number>(documents.length).fill(Number.NEGATIVE_INFINITY)
      for (const r of ranked) {
        if (r.id >= 0 && r.id < scores.length) scores[r.id] = r.score
      }
      return scores
    },
  }
}
