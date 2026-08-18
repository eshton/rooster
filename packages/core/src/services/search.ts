import type { Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import type { Embedder } from '../notify.js'
import { authorize, can } from '../permissions.js'
import { reciprocalRankFusion } from '../rag.js'
import { parse } from '../validate.js'
import { type Id, type RagSearchInput, ragSearchInput } from './deps.js'

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

/** A resolved, cited retrieval hit ready to ground an answer. */
export interface RagHit {
  sourceType: RagSourceType
  /** Human locator: ticket key, `TICKET#stage` for a message, or a doc name. */
  sourceKey: string
  /** Project key the source belongs to (for the agent to navigate). */
  projectKey: string
  /** The ticket this source is tied to, when applicable. */
  ticketId?: Id
  /** A short passage from the matched source, for grounding + relevance judging. */
  snippet: string
  /** RRF fusion score; higher = more relevant. */
  score: number
}

export interface RagSearchResult {
  hits: RagHit[]
  /** The hits pre-formatted with citation markers, ready to paste into a prompt. */
  contextBlock: string
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
  /**
   * Grounded RAG retrieval: {@link hybrid} + resolve each hit to a citation
   * (source key, project, snippet), apply project/ticket filters, and assemble a
   * ready-to-ground context block. Retrieval only — the caller generates.
   */
  rag(actor: Actor, input: RagSearchInput): Promise<RagSearchResult>
}

/** Collapse whitespace and cap a source's text into a citation snippet. */
function snippetOf(text: string, max = 240): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
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

    async rag(actor, rawInput) {
      authorize(actor, 'ticket:read')
      const input = parse(ragSearchInput, rawInput)
      const limit = Math.min(Math.max(input.limit ?? 8, 1), 50)

      // Over-fetch fused candidates, then resolve + filter down to `limit`:
      // project/ticket filters need the resolved source rows.
      const pool = await this.hybrid(actor, {
        query: input.query,
        sourceTypes: input.sourceTypes,
        limit: limit * Math.max(1, Math.floor(overfetch)),
      })

      const projectKeyOf = async (projectId: Id): Promise<string> =>
        (await repos.projects.getById(actor.orgId, projectId))?.key ?? ''

      const resolve = async (h: HybridHit): Promise<RagHit | null> => {
        if (h.sourceType === 'ticket') {
          const t = await repos.tickets.getById(actor.orgId, h.sourceId)
          if (!t) return null
          if (input.projectId && t.projectId !== input.projectId) return null
          if (input.ticketId && t.id !== input.ticketId) return null
          return {
            sourceType: 'ticket',
            sourceKey: t.key,
            projectKey: await projectKeyOf(t.projectId),
            ticketId: t.id,
            snippet: snippetOf(`${t.title}\n${t.description ?? ''}`),
            score: h.score,
          }
        }
        if (h.sourceType === 'message') {
          const m = await repos.conversation.getById(actor.orgId, h.sourceId)
          if (!m) return null
          if (input.ticketId && m.ticketId !== input.ticketId) return null
          const t = await repos.tickets.getById(actor.orgId, m.ticketId)
          if (input.projectId && t?.projectId !== input.projectId) return null
          return {
            sourceType: 'message',
            sourceKey: t ? `${t.key}#${m.stage}` : m.id,
            projectKey: t ? await projectKeyOf(t.projectId) : '',
            ticketId: m.ticketId,
            snippet: snippetOf(m.body),
            score: h.score,
          }
        }
        // context_file
        const cf = await repos.contextFiles.getById(actor.orgId, h.sourceId)
        if (!cf) return null
        if (input.projectId && cf.projectId !== input.projectId) return null
        if (input.ticketId && cf.ticketId !== input.ticketId) return null
        return {
          sourceType: 'context_file',
          sourceKey: cf.name,
          projectKey: await projectKeyOf(cf.projectId),
          ticketId: cf.ticketId ?? undefined,
          snippet: snippetOf(`${cf.name}\n${cf.body}`),
          score: h.score,
        }
      }

      const hits: RagHit[] = []
      for (const h of pool) {
        const r = await resolve(h)
        if (r) hits.push(r)
        if (hits.length >= limit) break
      }

      const contextBlock = hits
        .map((h, i) => `[${i + 1}] (${h.sourceKey}) ${h.snippet}`)
        .join('\n\n')

      return { hits, contextBlock }
    },
  }
}
