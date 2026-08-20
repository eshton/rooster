import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { NotFoundError, ValidationError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import { canTransitionIn, getDefaultWorkflow } from '../workflow.js'
import {
  type ChangeLifecycleStageInput,
  type CreateCustomerInput,
  type Customer,
  changeLifecycleStageInput,
  createCustomerInput,
  type Id,
  type ListCustomerWorkInput,
  listCustomerWorkInput,
  type Project,
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
  /** Patch a customer's fields (not lifecycle stage — see {@link changeLifecycleStage}). */
  update(actor: Actor, id: Id, input: UpdateCustomerInput): Promise<Customer>
  /**
   * Move a customer to a new lifecycle stage, validated against the customer
   * workflow (ROO-55). Rejects same-stage no-ops and illegal transitions.
   */
  changeLifecycleStage(actor: Actor, input: ChangeLifecycleStageInput): Promise<Customer>
  /**
   * Every delivery project serving this customer, across all their deals
   * (ROO-50) — the unified view: one relationship, all the work.
   */
  listWork(actor: Actor, input: ListCustomerWorkInput, opts?: ListOptions): Promise<Project[]>
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

    async changeLifecycleStage(actor, rawInput) {
      authorize(actor, 'crm:write')
      const { customerId, stage } = parse(changeLifecycleStageInput, rawInput)
      const before = await load(actor, customerId)
      if (before.lifecycleStage === stage) {
        throw new ValidationError(`Customer ${customerId} is already '${stage}'`)
      }
      // Validate against the active customer workflow (default today; the seam
      // for per-workspace overrides, ROO-53).
      const workflow = getDefaultWorkflow('customer')
      if (!canTransitionIn(workflow, before.lifecycleStage, stage)) {
        throw new ValidationError(
          `Illegal lifecycle transition '${before.lifecycleStage}' → '${stage}'`,
        )
      }
      const after = await repos.customers.update(actor.orgId, customerId, { lifecycleStage: stage })
      if (!after) throw new NotFoundError(`Customer ${customerId} not found`)
      await recordAudit(repos, actor, {
        action: 'customer.change_lifecycle_stage',
        targetType: 'customer',
        targetId: customerId,
        before,
        after,
      })
      return after
    },

    async listWork(actor, rawInput, opts) {
      authorize(actor, 'crm:read')
      const { customerId } = parse(listCustomerWorkInput, rawInput)
      return repos.projects.listForCustomer(actor.orgId, customerId, opts)
    },
  }
}
