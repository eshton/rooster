import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError, ValidationError } from '../errors.js'
import type { Embedder } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type AppendMessagesInput,
  appendMessagesInput,
  type ConversationMessage,
  type ConversationStage,
  type Id,
  type ListMessagesInput,
  listMessagesInput,
  type MessageRole,
  type RecallConversationsInput,
  recallConversationsInput,
  type Ticket,
} from './deps.js'

/** The `sourceType` discriminator for conversation messages in the embeddings store. */
const EMBED_SOURCE_MESSAGE = 'message'

/** A semantic-recall hit: a matched message plus enough to locate + read it. */
export interface ConversationRecallHit {
  messageId: Id
  ticketId: Id
  /** The ticket's human key (encodes the project prefix, e.g. ROO-42). */
  ticketKey: string
  stage: ConversationStage
  role: MessageRole
  /** First ~200 chars of the message body, for relevance judging. */
  snippet: string
  /** Similarity in [~-1, 1]; higher = closer (1 − cosine distance). */
  score: number
}

export interface ConversationService {
  /** Append a batch of staged messages to a ticket's conversation trace. */
  append(actor: Actor, input: AppendMessagesInput): Promise<ConversationMessage[]>
  /** List a ticket's conversation messages (optionally one stage). */
  list(actor: Actor, input: ListMessagesInput, opts?: ListOptions): Promise<ConversationMessage[]>
  /**
   * Semantic recall over conversation messages across ALL projects in the org
   * (org-scoped vector search = cross-project). Optional `stage`/`role` filters.
   * Requires `conversation:read` and a configured embedder.
   */
  recall(actor: Actor, input: RecallConversationsInput): Promise<ConversationRecallHit[]>
  /** Hard-delete one message (redaction). */
  redact(actor: Actor, messageId: Id): Promise<{ removed: boolean }>
  /** Hard-delete all of a ticket's messages (redaction). */
  redactForTicket(actor: Actor, ticketId: Id): Promise<{ removed: number }>
}

export function createConversationService(
  repos: Repositories,
  embedder?: Embedder,
): ConversationService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
    return ticket
  }

  /**
   * Best-effort embed of freshly-appended text messages for cross-project recall.
   * Skips non-text kinds (tool spew) and never throws — a failure just leaves
   * those messages out of the index until a future re-embed.
   */
  async function embedMessages(orgId: Id, messages: ConversationMessage[]): Promise<void> {
    if (!embedder) return
    const e = embedder
    const text = messages.filter((m) => m.kind === 'text')
    if (text.length === 0) return
    try {
      const vecs = await e.embed(text.map((m) => m.body))
      await Promise.all(
        text.map((m, i) => {
          const v = vecs[i]
          return v ? repos.embeddings.upsert(orgId, EMBED_SOURCE_MESSAGE, m.id, v, e.model) : null
        }),
      )
    } catch {
      // best-effort — see doc comment.
    }
  }

  return {
    async append(actor, rawInput) {
      authorize(actor, 'conversation:write')
      const input = parse(appendMessagesInput, rawInput)
      await requireTicket(actor, input.ticketId)

      // authorId is the trusted principal recording the trace (the caller); the
      // per-message `role` distinguishes whose turn it captures (human vs agent).
      const messages = await repos.conversation.appendMany(
        actor.orgId,
        input.ticketId,
        input.stage,
        input.messages.map((m) => ({
          authorId: actor.principalId,
          role: m.role,
          kind: m.kind,
          body: m.body,
          metadata: m.metadata ?? null,
        })),
      )

      // One audit record per flush (not per line) — keeps the log a useful index.
      await recordAudit(repos, actor, {
        action: 'conversation.append',
        targetType: 'ticket',
        targetId: input.ticketId,
        after: { stage: input.stage, count: messages.length },
      })
      // Index the new text messages for cross-project recall (best-effort).
      await embedMessages(actor.orgId, messages)
      return messages
    },

    async list(actor, rawInput, opts) {
      authorize(actor, 'conversation:read')
      const input = parse(listMessagesInput, rawInput)
      await requireTicket(actor, input.ticketId)
      return repos.conversation.listForTicket(actor.orgId, input.ticketId, {
        ...opts,
        stage: input.stage,
      })
    },

    async recall(actor, rawInput) {
      authorize(actor, 'conversation:read')
      if (!embedder) {
        throw new ValidationError(
          'Semantic search is not configured on this instance (set ROOSTER_EMBEDDING_URL + ROOSTER_EMBEDDING_API_KEY).',
        )
      }
      const input = parse(recallConversationsInput, rawInput)
      const n = Math.min(Math.max(input.limit ?? 10, 1), 50)
      const [vec] = await embedder.embed([input.query])
      if (!vec) return []
      // Over-fetch the global ANN pool so the org/stage/role filters still yield ~n.
      const hits = await repos.embeddings.search(actor.orgId, EMBED_SOURCE_MESSAGE, vec, n * 5)
      const results: ConversationRecallHit[] = []
      for (const hit of hits) {
        const msg = await repos.conversation.getById(actor.orgId, hit.sourceId)
        if (!msg) continue
        if (input.stage && msg.stage !== input.stage) continue
        if (input.role && msg.role !== input.role) continue
        const ticket = await repos.tickets.getById(actor.orgId, msg.ticketId)
        if (!ticket) continue
        results.push({
          messageId: msg.id,
          ticketId: ticket.id,
          ticketKey: ticket.key,
          stage: msg.stage,
          role: msg.role,
          snippet: msg.body.slice(0, 200),
          score: Math.round((1 - hit.distance) * 1000) / 1000,
        })
        if (results.length >= n) break
      }
      return results
    },

    async redact(actor, messageId) {
      authorize(actor, 'conversation:write')
      const removed = await repos.conversation.delete(actor.orgId, messageId)
      if (removed) {
        // Keep the vector index in sync with the redaction.
        await repos.embeddings.delete(actor.orgId, EMBED_SOURCE_MESSAGE, messageId)
        await recordAudit(repos, actor, {
          action: 'conversation.redact',
          targetType: 'conversation_message',
          targetId: messageId,
        })
      }
      return { removed }
    },

    async redactForTicket(actor, ticketId) {
      authorize(actor, 'conversation:write')
      await requireTicket(actor, ticketId)
      // Collect ids first so we can drop their embeddings alongside the rows.
      const existing = await repos.conversation.listForTicket(actor.orgId, ticketId, { limit: 200 })
      const removed = await repos.conversation.deleteForTicket(actor.orgId, ticketId)
      await Promise.all(
        existing.map((m) => repos.embeddings.delete(actor.orgId, EMBED_SOURCE_MESSAGE, m.id)),
      )
      if (removed > 0) {
        await recordAudit(repos, actor, {
          action: 'conversation.redact',
          targetType: 'ticket',
          targetId: ticketId,
          after: { removed },
        })
      }
      return { removed }
    },
  }
}
