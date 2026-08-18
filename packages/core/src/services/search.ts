import type { Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import type { Embedder } from '../notify.js'
import { authorize, can } from '../permissions.js'
import { reciprocalRankFusion } from '../rag.js'
import type { Id } from './deps.js'

/** Embedding `source_type` discriminators (mirror the per-service constants). */
export const RAG_SOURCE_TYPES = ['ticket', 'message', 'context_file'] as const
export type RagSourceType = (typeof RAG_SOURCE_TYPES)[number]

/** Sources that expose transcript/context content, gated by `conversation:read`. */
const GATED_SOURCE_TYPES: ReadonlySet<string> = new Set(['message', 'context_file'])

/** A fused retrieval hit — a source ranked by keyword+semantic fusion. */
export interface HybridHit {
  sourceType: RagSourceType
  sourceId: Id
  /** RRF score; higher = more relevant. Not comparable across queries. */
  score: number
}

export interface HybridSearchInput {
  query: string
  /** Restrict to these source types (default: all the actor may read). */
  sourceTypes?: RagSourceType[]
  /** Max fused results (1–50, default 10). */
  limit?: number
}

export interface SearchService {
  /**
   * Hybrid retrieval over the org's embedded corpus: fuse the FTS/keyword arm
   * (tickets) and the vector/semantic arm (all source types) with Reciprocal
   * Rank Fusion. Degrades to keyword-only when no embedder is configured, and to
   * semantic-only for non-ticket sources (FTS covers tickets today). Results are
   * scoped to what the actor may read.
   */
  hybrid(actor: Actor, input: HybridSearchInput): Promise<HybridHit[]>
}

const DEFAULT_OVERFETCH = 5

export function createSearchService(
  repos: Repositories,
  embedder?: Embedder,
  overfetch: number = DEFAULT_OVERFETCH,
): SearchService {
  const key = (sourceType: string, sourceId: string) => `${sourceType}:${sourceId}`

  return {
    async hybrid(actor, input) {
      authorize(actor, 'ticket:read')
      const query = input.query.trim()
      if (query.length === 0) return []

      const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
      const candidateK = limit * Math.max(1, Math.floor(overfetch))
      const includeGated = can(actor, 'conversation:read')

      // Which source types this actor may see, intersected with the request.
      const allowed = new Set<RagSourceType>(
        RAG_SOURCE_TYPES.filter((t) => includeGated || !GATED_SOURCE_TYPES.has(t)),
      )
      if (input.sourceTypes && input.sourceTypes.length > 0) {
        for (const t of [...allowed]) if (!input.sourceTypes.includes(t)) allowed.delete(t)
      }
      if (allowed.size === 0) return []

      // Vector/semantic arm across all source types (best chunk per source).
      const vectorArm: Array<{ key: string; sourceType: RagSourceType; sourceId: Id }> = []
      if (embedder) {
        const [vec] = await embedder.embed([query])
        if (vec) {
          const hits = await repos.embeddings.searchAny(actor.orgId, vec, candidateK)
          for (const h of hits) {
            const st = h.sourceType as RagSourceType
            if (allowed.has(st)) {
              vectorArm.push({ key: key(st, h.sourceId), sourceType: st, sourceId: h.sourceId })
            }
          }
        }
      }

      // Keyword/FTS arm — tickets only (the FTS index today).
      const keywordArm: Array<{ key: string; sourceType: RagSourceType; sourceId: Id }> = []
      if (allowed.has('ticket')) {
        const tickets = await repos.tickets.search(actor.orgId, query, { limit: candidateK })
        for (const t of tickets) {
          keywordArm.push({ key: key('ticket', t.id), sourceType: 'ticket', sourceId: t.id })
        }
      }

      return reciprocalRankFusion([vectorArm, keywordArm])
        .slice(0, limit)
        .map((f) => ({ sourceType: f.item.sourceType, sourceId: f.item.sourceId, score: f.score }))
    },
  }
}
