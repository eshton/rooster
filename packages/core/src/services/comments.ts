import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import type { ChunkConfig } from '../chunk.js'
import { embedAndStore } from '../embed.js'
import { NotFoundError } from '../errors.js'
import type { CrowNotifier, Embedder } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type Comment, type CommentInput, commentInput, type Id, type Ticket } from './deps.js'
import { emitToWatchers } from './watchers.js'

/** The `source_type` discriminator for comments in the embedding store (ROO-45). */
export const EMBED_SOURCE_COMMENT = 'comment'

/**
 * Skip embedding very short comments ("+1", "lgtm", "done"): they carry no
 * recallable signal and would only dilute the semantic index. Measured on the
 * trimmed body.
 */
const MIN_EMBED_COMMENT_LENGTH = 20

export interface CommentService {
  create(actor: Actor, input: CommentInput): Promise<Comment>
  list(actor: Actor, ticketId: Id, opts?: ListOptions): Promise<Comment[]>
}

export function createCommentService(
  repos: Repositories,
  crowNotifier?: CrowNotifier,
  embedder?: Embedder,
  chunkConfig?: ChunkConfig,
): CommentService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
    return ticket
  }

  /**
   * Best-effort embed of a freshly-created comment for semantic recall. Never
   * throws — a failure just leaves the comment out of the index until a
   * backfill. A no-op without an embedder or for a trivially short comment.
   */
  async function embedComment(orgId: Id, comment: Comment): Promise<void> {
    if (!embedder) return
    if (comment.body.trim().length < MIN_EMBED_COMMENT_LENGTH) return
    try {
      await embedAndStore(repos, embedder, chunkConfig, orgId, EMBED_SOURCE_COMMENT, [
        { id: comment.id, text: comment.body },
      ])
    } catch {
      // best-effort — see doc comment.
    }
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(commentInput, rawInput)
      const ticket = await requireTicket(actor, input.ticketId)

      const comment = await repos.comments.create(actor.orgId, {
        ticketId: input.ticketId,
        authorId: actor.principalId,
        body: input.body,
      })
      await embedComment(actor.orgId, comment)
      // Commenting on a ticket follows it.
      await repos.watchers.add(actor.orgId, input.ticketId, actor.principalId)
      await recordAudit(repos, actor, {
        action: 'comment.create',
        targetType: 'ticket',
        targetId: input.ticketId,
        after: { commentId: comment.id },
      })
      await emitToWatchers(repos, crowNotifier, actor, ticket, {
        kind: 'comment',
        commentId: comment.id,
      })
      return comment
    },

    async list(actor, ticketId, opts) {
      authorize(actor, 'ticket:read')
      await requireTicket(actor, ticketId)
      return repos.comments.listForTicket(actor.orgId, ticketId, opts)
    },
  }
}
