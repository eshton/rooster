import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { canDealTransition, INITIAL_DEAL_STAGE } from '../deal-transitions.js'
import { NotFoundError, ValidationError } from '../errors.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type ChangeDealStageInput,
  type CreateDealInput,
  changeDealStageInput,
  createDealInput,
  type Deal,
  type Id,
  type LinkDealWorkInput,
  type ListDealWorkInput,
  linkDealWorkInput,
  listDealWorkInput,
  type Project,
  type UpdateDealInput,
  updateDealInput,
} from './deps.js'

export interface DealService {
  /** Open a deal under a customer. */
  create(actor: Actor, input: CreateDealInput): Promise<Deal>
  /** A single deal by id. */
  get(actor: Actor, id: Id): Promise<Deal>
  /** List a customer's deals (most recent first). */
  list(actor: Actor, customerId: Id, opts?: ListOptions): Promise<Deal[]>
  /** Patch a deal's fields (not its stage — use {@link changeStage}). */
  update(actor: Actor, id: Id, input: UpdateDealInput): Promise<Deal>
  /** Move a deal to a new pipeline stage, validated against the pipeline. */
  changeStage(actor: Actor, input: ChangeDealStageInput): Promise<Deal>
  /**
   * Link an existing delivery project to this deal (ROO-50) — the won-deal →
   * work bridge. Sets the project's `dealId` and derives its `customerId` from
   * the deal, so the project also surfaces in the customer's work view.
   */
  linkWork(actor: Actor, input: LinkDealWorkInput): Promise<Project>
  /** The delivery projects linked to a deal. */
  listWork(actor: Actor, input: ListDealWorkInput, opts?: ListOptions): Promise<Project[]>
}

export function createDealService(repos: Repositories): DealService {
  async function load(actor: Actor, id: Id): Promise<Deal> {
    const deal = await repos.deals.getById(actor.orgId, id)
    if (!deal) throw new NotFoundError(`Deal ${id} not found`)
    return deal
  }

  return {
    async create(actor, rawInput) {
      authorize(actor, 'crm:write')
      const input = parse(createDealInput, rawInput)
      const customer = await repos.customers.getById(actor.orgId, input.customerId)
      if (!customer) throw new NotFoundError(`Customer ${input.customerId} not found`)

      const deal = await repos.deals.create(actor.orgId, {
        customerId: input.customerId,
        title: input.title,
        pipelineStage: input.pipelineStage ?? INITIAL_DEAL_STAGE,
        value: input.value ?? null,
        currency: input.currency ?? null,
        closeDate: input.closeDate ?? null,
        probability: input.probability ?? null,
        ownerId: input.ownerId ?? null,
        tags: input.tags,
      })
      await recordAudit(repos, actor, {
        action: 'deal.create',
        targetType: 'deal',
        targetId: deal.id,
        after: deal,
      })
      return deal
    },

    async get(actor, id) {
      authorize(actor, 'crm:read')
      return load(actor, id)
    },

    async list(actor, customerId, opts) {
      authorize(actor, 'crm:read')
      return repos.deals.listForCustomer(actor.orgId, customerId, opts)
    },

    async update(actor, id, rawInput) {
      authorize(actor, 'crm:write')
      const patch = parse(updateDealInput, rawInput)
      const before = await load(actor, id)
      const after = await repos.deals.update(actor.orgId, id, patch)
      if (!after) throw new NotFoundError(`Deal ${id} not found`)
      await recordAudit(repos, actor, {
        action: 'deal.update',
        targetType: 'deal',
        targetId: id,
        before,
        after,
      })
      return after
    },

    async changeStage(actor, rawInput) {
      authorize(actor, 'crm:write')
      const { dealId, stage } = parse(changeDealStageInput, rawInput)
      const before = await load(actor, dealId)
      if (before.pipelineStage === stage) {
        throw new ValidationError(`Deal ${dealId} is already in stage '${stage}'`)
      }
      if (!canDealTransition(before.pipelineStage, stage)) {
        throw new ValidationError(`Illegal deal transition '${before.pipelineStage}' → '${stage}'`)
      }
      const after = await repos.deals.update(actor.orgId, dealId, { pipelineStage: stage })
      if (!after) throw new NotFoundError(`Deal ${dealId} not found`)
      await recordAudit(repos, actor, {
        action: 'deal.change_stage',
        targetType: 'deal',
        targetId: dealId,
        before,
        after,
      })
      return after
    },

    async linkWork(actor, rawInput) {
      authorize(actor, 'crm:write')
      const { dealId, projectId } = parse(linkDealWorkInput, rawInput)
      const deal = await load(actor, dealId)
      const project = await repos.projects.getById(actor.orgId, projectId)
      if (!project) throw new NotFoundError(`Project ${projectId} not found`)

      const linked = await repos.projects.linkWork(actor.orgId, projectId, {
        customerId: deal.customerId,
        dealId: deal.id,
      })
      if (!linked) throw new NotFoundError(`Project ${projectId} not found`)
      await recordAudit(repos, actor, {
        action: 'deal.link_work',
        targetType: 'deal',
        targetId: dealId,
        after: { projectId, customerId: deal.customerId },
      })
      return linked
    },

    async listWork(actor, rawInput, opts) {
      authorize(actor, 'crm:read')
      const { dealId } = parse(listDealWorkInput, rawInput)
      return repos.projects.listForDeal(actor.orgId, dealId, opts)
    },
  }
}
