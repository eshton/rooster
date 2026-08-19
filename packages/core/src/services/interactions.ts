import type { ListOptions, Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import type { ChunkConfig } from '../chunk.js'
import { embedAndStore } from '../embed.js'
import { NotFoundError } from '../errors.js'
import type { Embedder } from '../notify.js'
import { authorize } from '../permissions.js'
import { parse } from '../validate.js'
import {
  type Interaction,
  type ListInteractionsInput,
  type LogInteractionInput,
  listInteractionsInput,
  logInteractionInput,
} from './deps.js'

/** Embedding `source_type` for interactions — surfaced in recall_context / rag_search. */
export const EMBED_SOURCE_INTERACTION = 'interaction'

export interface InteractionService {
  /** Log a call/email/note/meeting against a customer, deal, or contact. */
  log(actor: Actor, input: LogInteractionInput): Promise<Interaction>
  /** List interactions on a target (most recent by occurredAt first). */
  list(actor: Actor, input: ListInteractionsInput, opts?: ListOptions): Promise<Interaction[]>
}

export function createInteractionService(
  repos: Repositories,
  embedder?: Embedder,
  chunkConfig?: ChunkConfig,
): InteractionService {
  // The target (customer/deal/contact) must exist and be in this org.
  async function requireTarget(actor: Actor, input: LogInteractionInput): Promise<void> {
    const orgId = actor.orgId
    const exists =
      input.targetType === 'customer'
        ? await repos.customers.getById(orgId, input.targetId)
        : input.targetType === 'deal'
          ? await repos.deals.getById(orgId, input.targetId)
          : await repos.contacts.getById(orgId, input.targetId)
    if (!exists) throw new NotFoundError(`${input.targetType} ${input.targetId} not found`)
  }

  return {
    async log(actor, rawInput) {
      authorize(actor, 'crm:write')
      const input = parse(logInteractionInput, rawInput)
      await requireTarget(actor, input)

      const interaction = await repos.interactions.create(actor.orgId, {
        targetType: input.targetType,
        targetId: input.targetId,
        kind: input.kind,
        body: input.body,
        authorId: actor.principalId,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        metadata: input.metadata ?? null,
      })
      await recordAudit(repos, actor, {
        action: 'interaction.log',
        targetType: 'interaction',
        targetId: interaction.id,
        after: { kind: interaction.kind, target: `${input.targetType}:${input.targetId}` },
      })
      // Embed the body for RAG recall over the relationship history (best-effort).
      try {
        await embedAndStore(repos, embedder, chunkConfig, actor.orgId, EMBED_SOURCE_INTERACTION, [
          { id: interaction.id, text: interaction.body },
        ])
      } catch {
        // best-effort — a failed embed just leaves it out of recall until re-index.
      }
      return interaction
    },

    async list(actor, rawInput, opts) {
      authorize(actor, 'crm:read')
      const input = parse(listInteractionsInput, rawInput)
      return repos.interactions.listForTarget(actor.orgId, input.targetType, input.targetId, opts)
    },
  }
}
