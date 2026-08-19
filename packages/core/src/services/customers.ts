import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type CreateCustomerInput,
  type Customer,
  createCustomerInput,
  type Id,
  type UpdateCustomerInput,
  updateCustomerInput,
} from './deps.js'

export interface CustomerService {
  /** Create a customer/client (the relationship root). */
  create(actor: Actor, input: CreateCustomerInput): Promise<Customer>
  /** A single customer by id. */
  get(actor: Actor, id: Id): Promise<Customer>
  /** List the org's customers (most recent first). */
  list(actor: Actor, opts?: ListOptions): Promise<Customer[]>
  /** Patch a customer's fields. */
  update(actor: Actor, id: Id, input: UpdateCustomerInput): Promise<Customer>
}

export function createCustomerService(repos: Repositories): CustomerService {
  async function load(actor: Actor, id: Id): Promise<Customer> {
    const customer = await repos.customers.getById(actor.orgId, id)
    if (!customer) throw new NotFoundError(`Customer ${id} not found`)
    return customer
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'crm:write')
      const input = parse(createCustomerInput, rawInput)
      const customer = await repos.customers.create(actor.orgId, {
        name: input.name,
        lifecycleStage: input.lifecycleStage ?? 'lead',
        ownerId: input.ownerId ?? null,
        tags: input.tags,
      })
      await recordAudit(repos, actor, {
        action: 'customer.create',
        targetType: 'customer',
        targetId: customer.id,
        after: customer,
      })
      return customer
    },

    async get(actor, id) {
      authorize(actor, 'crm:read')
      return load(actor, id)
    },

    async list(actor, opts) {
      authorize(actor, 'crm:read')
      return repos.customers.list(actor.orgId, opts)
    },

    async update(actor, id, rawInput) {
      authorize(actor, 'crm:write')
      const patch = parse(updateCustomerInput, rawInput)
      const before = await load(actor, id)
      const after = await repos.customers.update(actor.orgId, id, patch)
      if (!after) throw new NotFoundError(`Customer ${id} not found`)
      await recordAudit(repos, actor, {
        action: 'customer.update',
        targetType: 'customer',
        targetId: id,
        before,
        after,
      })
      return after
    },
  }
}
