import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type AppendMessagesInput,
  appendMessagesInput,
  type ConversationMessage,
  type Id,
  type ListMessagesInput,
  listMessagesInput,
  type Ticket,
} from './deps.js'

export interface ConversationService {
  /** Append a batch of staged messages to a ticket's conversation trace. */
  append(actor: Actor, input: AppendMessagesInput): Promise<ConversationMessage[]>
  /** List a ticket's conversation messages (optionally one stage). */
  list(actor: Actor, input: ListMessagesInput, opts?: ListOptions): Promise<ConversationMessage[]>
  /** Hard-delete one message (redaction). */
  redact(actor: Actor, messageId: Id): Promise<{ removed: boolean }>
  /** Hard-delete all of a ticket's messages (redaction). */
  redactForTicket(actor: Actor, ticketId: Id): Promise<{ removed: number }>
}

export function createConversationService(repos: Repositories): ConversationService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<Ticket> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
    return ticket
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

    async redact(actor, messageId) {
      authorize(actor, 'conversation:write')
      const removed = await repos.conversation.delete(actor.orgId, messageId)
      if (removed) {
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
      const removed = await repos.conversation.deleteForTicket(actor.orgId, ticketId)
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
