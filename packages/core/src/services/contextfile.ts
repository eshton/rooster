import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError, ValidationError } from '../errors.js'
import type { Embedder } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type ContextFile,
  type ConversationStage,
  type Id,
  type ListContextFilesInput,
  listContextFilesInput,
  type MessageRole,
  type RecallContextInput,
  recallContextInput,
  type SaveContextFileInput,
  saveContextFileInput,
} from './deps.js'

const EMBED_SOURCE_CONTEXT_FILE = 'context_file'

/** A unified recall hit, discriminated by which kind of source matched. */
export type RecallContextHit =
  | { source: 'ticket'; ticketId: Id; ticketKey: string; snippet: string; score: number }
  | {
      source: 'message'
      messageId: Id
      ticketId: Id
      ticketKey: string
      stage: ConversationStage
      role: MessageRole
      snippet: string
      score: number
    }
  | {
      source: 'context_file'
      contextFileId: Id
      name: string
      projectId: Id
      ticketId: Id | null
      snippet: string
      score: number
    }

export interface ContextFileService {
  /** Create (no id) or update (id) a project context document. */
  save(actor: Actor, input: SaveContextFileInput): Promise<ContextFile>
  /** List a project's context files (optionally only those pinned to a ticket). */
  list(actor: Actor, input: ListContextFilesInput, opts?: ListOptions): Promise<ContextFile[]>
  /** Fetch one context file by id. */
  get(actor: Actor, id: Id): Promise<ContextFile>
  /** Delete a context file (and its embedding). */
  remove(actor: Actor, id: Id): Promise<{ removed: boolean }>
  /**
   * Unified semantic recall across tickets, conversation messages and context
   * files in the org (cross-project). Requires `conversation:read` (it can
   * surface message/context content) and a configured embedder.
   */
  recall(actor: Actor, input: RecallContextInput): Promise<RecallContextHit[]>
}

const snippetOf = (s: string) => s.slice(0, 200)

export function createContextFileService(
  repos: Repositories,
  embedder?: Embedder,
): ContextFileService {
  async function embedContextFile(orgId: Id, file: ContextFile): Promise<void> {
    if (!embedder) return
    const e = embedder
    try {
      const [vec] = await e.embed([`${file.name}\n${file.body}`])
      if (vec)
        await repos.embeddings.upsert(orgId, EMBED_SOURCE_CONTEXT_FILE, file.id, vec, e.model)
    } catch {
      // best-effort — leave un-embedded until a future save/backfill.
    }
  }

  return {
    async save(actor, rawInput) {
      authorize(actor, 'project:write')
      const input = parse(saveContextFileInput, rawInput)
      const project = await repos.projects.getById(actor.orgId, input.projectId)
      if (!project) throw new NotFoundError(`Project ${input.projectId} not found`)
      if (input.ticketId != null) {
        const ticket = await repos.tickets.getById(actor.orgId, input.ticketId)
        if (!ticket) throw new NotFoundError(`Ticket ${input.ticketId} not found`)
      }

      let file: ContextFile
      if (input.id) {
        const existing = await repos.contextFiles.getById(actor.orgId, input.id)
        if (!existing) throw new NotFoundError(`Context file ${input.id} not found`)
        file = await repos.contextFiles.update(actor.orgId, input.id, {
          projectId: input.projectId,
          ticketId: input.ticketId ?? null,
          name: input.name,
          body: input.body,
        })
      } else {
        file = await repos.contextFiles.create(actor.orgId, {
          projectId: input.projectId,
          ticketId: input.ticketId ?? null,
          name: input.name,
          body: input.body,
          authorId: actor.principalId,
        })
      }

      await recordAudit(repos, actor, {
        action: input.id ? 'context_file.update' : 'context_file.create',
        targetType: 'context_file',
        targetId: file.id,
        after: { projectId: file.projectId, name: file.name },
      })
      await embedContextFile(actor.orgId, file)
      return file
    },

    async list(actor, rawInput, opts) {
      authorize(actor, 'ticket:read')
      const input = parse(listContextFilesInput, rawInput)
      return repos.contextFiles.list(actor.orgId, input.projectId, {
        ...opts,
        ticketId: input.ticketId,
      })
    },

    async get(actor, id) {
      authorize(actor, 'ticket:read')
      const file = await repos.contextFiles.getById(actor.orgId, id)
      if (!file) throw new NotFoundError(`Context file ${id} not found`)
      return file
    },

    async remove(actor, id) {
      authorize(actor, 'project:write')
      const removed = await repos.contextFiles.delete(actor.orgId, id)
      if (removed) {
        await repos.embeddings.delete(actor.orgId, EMBED_SOURCE_CONTEXT_FILE, id)
        await recordAudit(repos, actor, {
          action: 'context_file.delete',
          targetType: 'context_file',
          targetId: id,
        })
      }
      return { removed }
    },

    async recall(actor, rawInput) {
      authorize(actor, 'conversation:read')
      if (!embedder) {
        throw new ValidationError(
          'Semantic search is not configured on this instance (set ROOSTER_EMBEDDING_URL + ROOSTER_EMBEDDING_API_KEY).',
        )
      }
      const input = parse(recallContextInput, rawInput)
      const n = Math.min(Math.max(input.limit ?? 10, 1), 50)
      const [vec] = await embedder.embed([input.query])
      if (!vec) return []
      const hits = await repos.embeddings.searchAny(actor.orgId, vec, n * 5)
      const results: RecallContextHit[] = []
      for (const hit of hits) {
        const score = Math.round((1 - hit.distance) * 1000) / 1000
        if (hit.sourceType === 'ticket') {
          const t = await repos.tickets.getById(actor.orgId, hit.sourceId)
          if (!t) continue
          results.push({
            source: 'ticket',
            ticketId: t.id,
            ticketKey: t.key,
            snippet: snippetOf(`${t.title}\n${t.description ?? ''}`),
            score,
          })
        } else if (hit.sourceType === 'message') {
          const m = await repos.conversation.getById(actor.orgId, hit.sourceId)
          if (!m) continue
          const t = await repos.tickets.getById(actor.orgId, m.ticketId)
          if (!t) continue
          results.push({
            source: 'message',
            messageId: m.id,
            ticketId: t.id,
            ticketKey: t.key,
            stage: m.stage,
            role: m.role,
            snippet: snippetOf(m.body),
            score,
          })
        } else if (hit.sourceType === EMBED_SOURCE_CONTEXT_FILE) {
          const f = await repos.contextFiles.getById(actor.orgId, hit.sourceId)
          if (!f) continue
          results.push({
            source: 'context_file',
            contextFileId: f.id,
            name: f.name,
            projectId: f.projectId,
            ticketId: f.ticketId,
            snippet: snippetOf(f.body),
            score,
          })
        }
        if (results.length >= n) break
      }
      return results
    },
  }
}
