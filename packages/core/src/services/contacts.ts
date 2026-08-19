import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type Contact,
  type CreateContactInput,
  createContactInput,
  type Id,
  type UpdateContactInput,
  updateContactInput,
} from './deps.js'

export interface ContactService {
  /** Add a contact (person) to a customer. */
  add(actor: Actor, input: CreateContactInput): Promise<Contact>
  /** List a customer's contacts (most recent first). */
  list(actor: Actor, customerId: Id, opts?: ListOptions): Promise<Contact[]>
  /** Patch a contact's fields. */
  update(actor: Actor, id: Id, input: UpdateContactInput): Promise<Contact>
  /** Remove a contact. */
  remove(actor: Actor, id: Id): Promise<{ removed: boolean }>
}

export function createContactService(repos: Repositories): ContactService {
  return {
    async add(actor, rawInput) {
      authorize(actor, 'crm:write')
      const input = parse(createContactInput, rawInput)
      // The customer must exist (and be in this org) before attaching a contact.
      const customer = await repos.customers.getById(actor.orgId, input.customerId)
      if (!customer) throw new NotFoundError(`Customer ${input.customerId} not found`)

      const contact = await repos.contacts.create(actor.orgId, {
        customerId: input.customerId,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        role: input.role ?? null,
      })
      await recordAudit(repos, actor, {
        action: 'contact.create',
        targetType: 'contact',
        targetId: contact.id,
        after: contact,
      })
      return contact
    },

    async list(actor, customerId, opts) {
      authorize(actor, 'crm:read')
      return repos.contacts.listForCustomer(actor.orgId, customerId, opts)
    },

    async update(actor, id, rawInput) {
      authorize(actor, 'crm:write')
      const patch = parse(updateContactInput, rawInput)
      const before = await repos.contacts.getById(actor.orgId, id)
      if (!before) throw new NotFoundError(`Contact ${id} not found`)
      const after = await repos.contacts.update(actor.orgId, id, patch)
      if (!after) throw new NotFoundError(`Contact ${id} not found`)
      await recordAudit(repos, actor, {
        action: 'contact.update',
        targetType: 'contact',
        targetId: id,
        before,
        after,
      })
      return after
    },

    async remove(actor, id) {
      authorize(actor, 'crm:write')
      const removed = await repos.contacts.delete(actor.orgId, id)
      if (removed) {
        await recordAudit(repos, actor, {
          action: 'contact.delete',
          targetType: 'contact',
          targetId: id,
        })
      }
      return { removed }
    },
  }
}
