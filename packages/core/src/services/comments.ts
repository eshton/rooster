import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import type { CrowNotifier } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { type Comment, type CommentInput, commentInput, type Id, type Ticket } from './deps.js'
import { emitToWatchers } from './watchers.js'

export interface CommentService {
  create(actor: Actor, input: CommentInput): Promise<Comment>
  list(actor: Actor, ticketId: Id, opts?: ListOptions): Promise<Comment[]>
}

export function createCommentService(
  repos: Repositories,
  crowNotifier?: CrowNotifier,
): CommentService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
    return ticket
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
