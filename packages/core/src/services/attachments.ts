import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type AddAttachmentInput,
  type Attachment,
  addAttachmentInput,
  type Id,
  type RemoveAttachmentInput,
  removeAttachmentInput,
} from './deps.js'

export interface AttachmentService {
  /** Attach a link (URL + optional label) to a ticket. */
  add(actor: Actor, input: AddAttachmentInput): Promise<Attachment>
  list(actor: Actor, ticketId: Id, opts?: ListOptions): Promise<Attachment[]>
  remove(actor: Actor, input: RemoveAttachmentInput): Promise<{ removed: true }>
}

export function createAttachmentService(repos: Repositories): AttachmentService {
  async function requireTicket(actor: Actor, ticketId: Id): Promise<void> {
    const ticket = await repos.tickets.getById(actor.orgId, ticketId)
    if (!ticket) throw new NotFoundError(`Ticket ${ticketId} not found`)
  }

  return {
    async add(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(addAttachmentInput, rawInput)
      await requireTicket(actor, input.ticketId)

      const attachment = await repos.attachments.create(actor.orgId, {
        ticketId: input.ticketId,
        addedById: actor.principalId,
        url: input.url,
        label: input.label ?? null,
      })
      await recordAudit(repos, actor, {
        action: 'attachment.add',
        targetType: 'ticket',
        targetId: input.ticketId,
        after: attachment,
      })
      return attachment
    },

    async list(actor, ticketId, opts) {
      authorize(actor, 'ticket:read')
      await requireTicket(actor, ticketId)
      return repos.attachments.listForTicket(actor.orgId, ticketId, opts)
    },

    async remove(actor, rawInput) {
      authorize(actor, 'ticket:write')
      const input = parse(removeAttachmentInput, rawInput)
      const existing = await repos.attachments.getById(actor.orgId, input.attachmentId)
      if (!existing) throw new NotFoundError(`Attachment ${input.attachmentId} not found`)

      await repos.attachments.delete(actor.orgId, input.attachmentId)
      await recordAudit(repos, actor, {
        action: 'attachment.remove',
        targetType: 'ticket',
        targetId: existing.ticketId,
        before: existing,
      })
      return { removed: true }
    },
  }
}
