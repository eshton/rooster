import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type Actor,
  type ProvisionalIdentity,
  provisionTenantForAccount,
  type Services,
} from '@rooster/core'
import {
  addAttachmentInput,
  agentStatusSchema,
  appendMessagesInput,
  archiveProjectInput,
  assigneeRefInput,
  assignTicketInput,
  changeDealStageInput,
  changeLifecycleStageInput,
  changeStatusInput,
  claimNextInput,
  commentInput,
  conversationStageSchema,
  createContactInput,
  createCustomerInput,
  createDealInput,
  createInviteInput,
  createMilestoneInput,
  createProjectInput,
  createTeamInput,
  createTenantInput,
  createTicketInput,
  createTicketsInput,
  deleteProjectInput,
  inviteMemberInput,
  joinTenantInput,
  linkDealWorkInput,
  linkTicketsInput,
  listContextFilesInput,
  listCustomerWorkInput,
  listDealWorkInput,
  listInteractionsInput,
  logInteractionInput,
  moveProjectInput,
  moveTicketInput,
  ragSearchInput,
  recallContextInput,
  recallConversationsInput,
  registerAgentInput,
  removeAttachmentInput,
  saveContextFileInput,
  setProjectKeyInput,
  type Ticket,
  ticketStatusSchema,
  unlinkTicketsInput,
  updateContactInput,
  updateCustomerInput,
  updateDealInput,
  updateTicketInput,
  watchTicketInput,
} from '@rooster/schema'
import { z } from 'zod'
import { errorResult, jsonResult, runTool, withHint } from './result.js'

/**
 * The board-scan essentials of a ticket. `compact` list responses return these
 * instead of the full row, so an agent triaging a board pays far fewer tokens.
 */
function toCompact(t: Ticket) {
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    status: t.status,
    priority: t.priority,
    assigneeId: t.assigneeId,
  }
}

/** Apply the compact projection to a list of tickets when `compact` is set. */
function maybeCompact(tickets: Ticket[], compact: boolean | undefined) {
  return compact ? tickets.map(toCompact) : tickets
}

export interface ToolDeps {
  services: Services
  actor: Actor
  /**
   * Whether this instance has an embeddings provider configured (semantic search
   * on). Surfaced in `whoami` and used to nudge keyword-search tools toward the
   * semantic ones (ROO-68). Defaults to false.
   */
  semanticSearch?: boolean
}

/** Nudge appended to keyword-search results when semantic search is available. */
const SEMANTIC_HINT =
  '💡 This was exact keyword search. Semantic search is configured on this instance — ' +
  'for meaning-based recall (related prior work, similar issues, "what did we decide about X") ' +
  'prefer find_similar_tickets, or rag_search / recall_context for grounded, cited answers.'

export interface ProvisioningToolDeps {
  services: Services
  provisional: ProvisionalIdentity
}

/**
 * Register the minimal toolset exposed to an authenticated-but-orgless caller:
 * `whoami` (reports the provisional status) and `create_tenant` (bootstraps the
 * workspace, after which a full token resolves to the new org). Nothing here
 * touches tenant data, so no {@link Actor} is required.
 */
export function registerProvisioningTools(
  server: McpServer,
  { services, provisional }: ProvisioningToolDeps,
): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description: 'Report your authenticated identity and onboarding status.',
      inputSchema: {},
    },
    async () =>
      jsonResult({
        authUserId: provisional.authUserId,
        email: provisional.email,
        name: provisional.name,
        status: 'provisional',
        hint: 'You are authenticated but have no workspace yet. Call create_tenant to make one.',
      }),
  )

  server.registerTool(
    'create_tenant',
    {
      title: 'Create your workspace',
      description:
        'Create your workspace (org) with its first project, then start filing tickets. Call this once; reconnecting later from any MCP client lands you back in the same workspace. Provide a workspace name and the first project name + key (the uppercase ticket prefix, e.g. "ROOST").',
      inputSchema: createTenantInput.shape,
    },
    async (args) =>
      runTool(async () => {
        const result = await provisionTenantForAccount(
          services,
          {
            authUserId: provisional.authUserId,
            email: provisional.email,
            name: provisional.name,
          },
          args,
        )
        return {
          workspace: { id: result.org.id, slug: result.org.slug, name: result.org.name },
          team: { id: result.team.id, key: result.team.key },
          project: { id: result.project.id, name: result.project.name, key: result.project.key },
          message: `Workspace '${result.org.name}' is ready. Create tickets in '${result.project.name}' — they'll be keyed ${result.project.key}-1, ${result.project.key}-2, …`,
        }
      }),
  )

  server.registerTool(
    'join_tenant',
    {
      title: 'Join a workspace',
      description:
        'Join an existing workspace using an invite code a teammate shared with you. After joining, reconnect and you have full access at the granted role.',
      inputSchema: joinTenantInput.shape,
    },
    async (args) =>
      runTool(async () => {
        const result = await services.invites.redeem(
          {
            authUserId: provisional.authUserId,
            email: provisional.email,
            name: provisional.name,
          },
          args,
        )
        return {
          workspace: { id: result.org.id, slug: result.org.slug, name: result.org.name },
          role: result.role,
          message: `You've joined '${result.org.name}' as ${result.role}.`,
        }
      }),
  )
}

/**
 * Register every Rooster MCP tool on the server. Each tool resolves the calling
 * agent's trusted {@link Actor} (already authenticated by the transport), calls
 * the core service — which enforces scope + writes the audit log — and returns
 * the result as JSON.
 */
export function registerTools(
  server: McpServer,
  { services, actor, semanticSearch = false }: ToolDeps,
): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        "Return the calling agent's trusted identity (principal id, org, role), granted scopes, " +
        'and instance capabilities (e.g. whether semantic search is available).',
      inputSchema: {},
    },
    async () =>
      jsonResult({
        orgId: actor.orgId,
        principalId: actor.principalId,
        type: actor.type,
        role: actor.role,
        scopes: actor.scopes,
        // Capability signal (ROO-68): when true, prefer find_similar_tickets /
        // rag_search / recall_context over keyword search for recall.
        semanticSearch,
      }),
  )

  server.registerTool(
    'list_teams',
    { title: 'List teams', description: 'List teams in your org.', inputSchema: {} },
    async () => runTool(() => services.teams.list(actor)),
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List projects, optionally filtered to a team.',
      inputSchema: { teamId: z.uuid().optional() },
    },
    async ({ teamId }) => runTool(() => services.projects.list(actor, teamId)),
  )

  server.registerTool(
    'list_workspaces',
    {
      title: 'List workspaces',
      description:
        'List the workspaces (orgs) your account belongs to, marking the current one. ' +
        "To act in another, send its orgId in the 'X-Rooster-Org' request header.",
      inputSchema: {},
    },
    async () => runTool(() => services.orgs.listWorkspaces(actor)),
  )

  server.registerTool(
    'create_workspace',
    {
      title: 'Create workspace',
      description:
        'Create an additional workspace (org) owned by your account, with its first project. ' +
        "Your account belongs to both; switch into the new one via the 'X-Rooster-Org' header. " +
        'Provide a workspace name and the first project name + key (3–5 char uppercase prefix).',
      inputSchema: createTenantInput.shape,
    },
    async (args) => runTool(() => services.orgs.createWorkspace(actor, args)),
  )

  server.registerTool(
    'create_team',
    {
      title: 'Create team',
      description:
        'Create a team in your org (admin only). The team `key` is the uppercase ticket prefix (e.g. "ROOST" → ROOST-1, ROOST-2).',
      inputSchema: createTeamInput.shape,
    },
    async (args) => runTool(() => services.teams.create(actor, args)),
  )

  server.registerTool(
    'create_project',
    {
      title: 'Create project',
      description: 'Create a project under a team. Tickets are filed into projects.',
      inputSchema: createProjectInput.shape,
    },
    async (args) => runTool(() => services.projects.create(actor, args)),
  )

  server.registerTool(
    'create_milestone',
    {
      title: 'Create milestone',
      description:
        'Create a milestone / cycle (sprint) in a project — a named, optionally time-boxed ' +
        '(startDate/dueDate) grouping. Assign tickets to it via create_ticket/update_ticket ' +
        '`milestoneId`, and filter the board with list_tickets `milestoneId`.',
      inputSchema: createMilestoneInput.shape,
    },
    async (args) => runTool(() => services.milestones.create(actor, args)),
  )

  server.registerTool(
    'list_milestones',
    {
      title: 'List milestones',
      description: "List a project's milestones / cycles.",
      inputSchema: { projectId: z.uuid() },
    },
    async ({ projectId }) => runTool(() => services.milestones.list(actor, projectId)),
  )

  server.registerTool(
    'set_project_key',
    {
      title: 'Set project key',
      description:
        "Rename a project's ticket-key prefix (3–5 chars, unique per workspace). " +
        'Re-keys every existing ticket in lockstep (<old>-<n> → <new>-<n>); numbers are unchanged. ' +
        'Use this instead of hand-editing the database.',
      inputSchema: setProjectKeyInput.shape,
    },
    async (args) => runTool(() => services.projects.setKey(actor, args)),
  )

  server.registerTool(
    'move_project',
    {
      title: 'Move project',
      description:
        'Move a project to another team in one call. Ticket keys, numbers and history ' +
        '(status, comments, labels) are preserved — numbering is per-project, so team ' +
        'membership is pure metadata. Use this instead of re-keying + moving tickets by hand.',
      inputSchema: moveProjectInput.shape,
    },
    async (args) => runTool(() => services.projects.move(actor, args)),
  )

  server.registerTool(
    'archive_project',
    {
      title: 'Archive project',
      description:
        'Archive (or, with `archived: false`, unarchive) a project. Reversible; keeps all ' +
        'tickets and history. Use this for stale projects you want to hide but not lose.',
      inputSchema: archiveProjectInput.shape,
    },
    async (args) => runTool(() => services.projects.archive(actor, args)),
  )

  server.registerTool(
    'delete_project',
    {
      title: 'Delete project',
      description:
        'Permanently delete an EMPTY project (one with no tickets). Irreversible. If the ' +
        'project still holds tickets, move or delete them first, or archive the project instead.',
      inputSchema: deleteProjectInput.shape,
    },
    async (args) => runTool(() => services.projects.delete(actor, args)),
  )

  server.registerTool(
    'list_tickets',
    {
      title: 'List tickets',
      description:
        'List tickets in a project, optionally filtered by status, assignee and/or milestone. ' +
        'Set `compact: true` to get just {id, key, title, status, priority, assigneeId} per ' +
        'ticket — far fewer tokens when scanning a board.',
      inputSchema: {
        projectId: z.uuid(),
        status: ticketStatusSchema.optional(),
        assigneeId: z.uuid().optional(),
        milestoneId: z.uuid().optional(),
        compact: z.boolean().optional(),
      },
    },
    async ({ projectId, status, assigneeId, milestoneId, compact }) =>
      runTool(async () =>
        maybeCompact(
          await services.tickets.list(actor, projectId, { status, assigneeId, milestoneId }),
          compact,
        ),
      ),
  )

  server.registerTool(
    'my_tickets',
    {
      title: 'My tickets',
      description:
        'List tickets across the org assigned to you (primary OR co-assignee). Set ' +
        '`compact: true` for the trimmed board-scan shape.',
      inputSchema: { compact: z.boolean().optional() },
    },
    async ({ compact }) =>
      runTool(async () => maybeCompact(await services.tickets.myTickets(actor), compact)),
  )

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket',
      description: 'Fetch a single ticket by id or by key (e.g. "ROOST-42").',
      inputSchema: { id: z.uuid().optional(), key: z.string().optional() },
    },
    async ({ id, key }) => {
      if (id) return runTool(() => services.tickets.get(actor, id))
      if (key) return runTool(() => services.tickets.getByKey(actor, key))
      return errorResult('Provide either "id" or "key"', 'validation')
    },
  )

  server.registerTool(
    'get_ticket_context',
    {
      title: 'Get ticket context',
      description:
        'Fetch a ticket together with everything around it — comments, attachments, subtasks, ' +
        'resolved links, the full assignee set, and the staged conversation trace (when you hold ' +
        'conversation:read) — in ONE call (by id or key). Prefer this over separate get_ticket + ' +
        'list_comments + list_links + list_subtasks + list_attachments + list_messages calls.',
      inputSchema: { id: z.uuid().optional(), key: z.string().optional() },
    },
    async ({ id, key }) => {
      if (!id && !key) return errorResult('Provide either "id" or "key"', 'validation')
      return runTool(async () => {
        const ticketId = id ?? (await services.tickets.getByKey(actor, key as string)).id
        return services.tickets.getContext(actor, ticketId)
      })
    },
  )

  server.registerTool(
    'create_ticket',
    {
      title: 'Create ticket',
      description:
        'Create a ticket. Always add relevant `labels` (tags) so related work is easy to find ' +
        'later, and set `parentId` when this is a subtask of another ticket. Pass an ' +
        '`idempotencyKey` to make a retried create safe — a repeat with the same key returns the ' +
        'original ticket instead of filing a duplicate.',
      inputSchema: createTicketInput.shape,
    },
    async (args) => runTool(() => services.tickets.create(actor, args)),
  )

  server.registerTool(
    'create_tickets',
    {
      title: 'Create tickets (batch)',
      description:
        'Open several tickets in ONE call — e.g. when bootstrapping a project. Pass `tickets` as ' +
        'an array of the same shape create_ticket takes (1–100). Returns the created tickets in ' +
        'input order. The whole batch is validated up front — shape AND every reference ' +
        '(project/assignee/milestone/parent) — so an invalid entry rejects the call before any ' +
        'row is written. Set a per-entry `idempotencyKey`: if a transient error interrupts a ' +
        'batch mid-write, re-send it unchanged to finish safely without creating duplicates.',
      inputSchema: createTicketsInput.shape,
    },
    async (args) => runTool(() => services.tickets.createMany(actor, args)),
  )

  server.registerTool(
    'update_ticket',
    {
      title: 'Update ticket',
      description:
        "Update a ticket's fields (title, description, priority, labels, assignee, parent). For " +
        'safe concurrent edits, pass `expectedUpdatedAt` (the updatedAt you last read): the write ' +
        'applies only if the ticket is unchanged, else it fails with a conflict so you re-read and retry.',
      inputSchema: { id: z.uuid(), ...updateTicketInput.shape },
    },
    async ({ id, ...patch }) => runTool(() => services.tickets.update(actor, id, patch)),
  )

  server.registerTool(
    'move_ticket',
    {
      title: 'Move ticket',
      description:
        'Move a ticket to another project. It gets a fresh key + number in the destination ' +
        '(the old key is freed). Use this instead of hand-editing the database.',
      inputSchema: moveTicketInput.shape,
    },
    async (args) => runTool(() => services.tickets.move(actor, args)),
  )

  server.registerTool(
    'change_status',
    {
      title: 'Change status',
      description:
        'Move a ticket to a new status (validated against the workflow). Optionally pass ' +
        '`expectedUpdatedAt` for an optimistic-concurrency guard (conflicts if changed meanwhile).',
      inputSchema: changeStatusInput.shape,
    },
    async (args) => runTool(() => services.tickets.changeStatus(actor, args)),
  )

  server.registerTool(
    'claim_next',
    {
      title: 'Claim next ticket',
      description:
        'Ask Rooster for the next thing to work on. Atomically claims the highest-priority, ' +
        'oldest, UNBLOCKED, unassigned ticket in a project (status backlog/todo) and assigns it ' +
        'to you — two agents racing never get the same ticket. Returns ' +
        '{ claimed, ticket }; when the board has nothing actionable, `claimed` is false and ' +
        '`ticket` is null.',
      inputSchema: claimNextInput.shape,
    },
    async (args) =>
      runTool(async () => {
        const ticket = await services.tickets.claimNext(actor, args)
        return { claimed: ticket !== null, ticket }
      }),
  )

  server.registerTool(
    'assign_ticket',
    {
      title: 'Assign ticket',
      description:
        'Assign a ticket to a principal (user or agent), or pass null to unassign. Optionally pass ' +
        '`expectedUpdatedAt` for an optimistic-concurrency guard (conflicts if changed meanwhile).',
      inputSchema: assignTicketInput.shape,
    },
    async (args) => runTool(() => services.tickets.assign(actor, args)),
  )

  server.registerTool(
    'add_assignee',
    {
      title: 'Add assignee',
      description:
        'Add a co-assignee (shared ownership — pair/mob, human + agent) alongside the primary ' +
        'assignee. They auto-follow the ticket. Use assign_ticket to set/clear the primary.',
      inputSchema: assigneeRefInput.shape,
    },
    async (args) => runTool(() => services.tickets.addAssignee(actor, args)),
  )

  server.registerTool(
    'remove_assignee',
    {
      title: 'Remove assignee',
      description: 'Remove an assignee from a ticket — the primary (clears it) or a co-assignee.',
      inputSchema: assigneeRefInput.shape,
    },
    async (args) => runTool(() => services.tickets.removeAssignee(actor, args)),
  )

  server.registerTool(
    'list_assignees',
    {
      title: 'List assignees',
      description: 'List all assignees of a ticket (primary + co-assignees), as principal ids.',
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.tickets.listAssignees(actor, ticketId)),
  )

  server.registerTool(
    'comment',
    {
      title: 'Comment',
      description: 'Add a comment to a ticket.',
      inputSchema: commentInput.shape,
    },
    async (args) => runTool(() => services.comments.create(actor, args)),
  )

  server.registerTool(
    'append_messages',
    {
      title: 'Append conversation messages',
      description:
        'Record the human↔agent conversation trace on a ticket, tagged by workflow ' +
        "`stage` (input | plan | execution | review). Flush a stage's turns in ONE " +
        'call as a batch (1–50). SUMMARISE — persist the curated trace (decisions, the ' +
        "human ask, the plan, key results), not raw tool output. Set each message's " +
        '`role` (human|agent). Ordering is assigned server-side. Later powers ' +
        'cross-project recall. Requires the conversation:write scope.',
      inputSchema: appendMessagesInput.shape,
    },
    async (args) => runTool(() => services.conversation.append(actor, args)),
  )

  server.registerTool(
    'list_messages',
    {
      title: 'List conversation messages',
      description:
        "A ticket's conversation trace (chronological), optionally filtered to one " +
        'stage. Requires the conversation:read scope.',
      inputSchema: { ticketId: z.uuid(), stage: conversationStageSchema.optional() },
    },
    async (args) => runTool(() => services.conversation.list(actor, args)),
  )

  server.registerTool(
    'recall_conversations',
    {
      title: 'Recall conversations',
      description:
        'Semantic recall over conversation traces across ALL projects in your workspace — find ' +
        'a past design discussion/decision by meaning and reuse it. Optionally filter by `stage` ' +
        '(input|plan|execution|review) or `role` (human|agent). Each hit returns a snippet + the ' +
        'ticketKey; call get_ticket_context on it to pull the full staged thread. Requires the ' +
        'conversation:read scope and embeddings configured (else returns an error).',
      inputSchema: recallConversationsInput.shape,
    },
    async (args) => runTool(() => services.conversation.recall(actor, args)),
  )

  server.registerTool(
    'save_context_file',
    {
      title: 'Save context file',
      description:
        'Save a named context document on a project (design notes, conventions, glossary…). ' +
        'Unlike attachments (URL-only), the text is stored and embedded for semantic recall. ' +
        'Omit `id` to create, pass it to update. Optionally pin to a ticket with `ticketId`.',
      inputSchema: saveContextFileInput.shape,
    },
    async (args) => runTool(() => services.contextFiles.save(actor, args)),
  )

  server.registerTool(
    'list_context_files',
    {
      title: 'List context files',
      description: "List a project's context documents (optionally only those pinned to a ticket).",
      inputSchema: listContextFilesInput.shape,
    },
    async (args) => runTool(() => services.contextFiles.list(actor, args)),
  )

  server.registerTool(
    'recall_context',
    {
      title: 'Recall context (unified)',
      description:
        'Unified semantic recall across tickets, conversation traces AND context files in your ' +
        'workspace (cross-project) — the broadest "have we figured this out before?" search. Each ' +
        'hit is tagged by `source` (ticket|message|context_file) with a snippet; follow up via ' +
        'get_ticket_context or list_context_files. Requires the conversation:read scope and ' +
        'embeddings configured.',
      inputSchema: recallContextInput.shape,
    },
    async (args) => runTool(() => services.contextFiles.recall(actor, args)),
  )

  server.registerTool(
    'rag_search',
    {
      title: 'RAG search (grounded retrieval)',
      description:
        'Grounded retrieval for RAG: hybrid keyword+semantic search across your workspace corpus ' +
        '(tickets, conversation traces, context files), returning ranked, cited hits plus a ' +
        'ready-to-ground `contextBlock` you can paste straight into a prompt. Optionally narrow by ' +
        '`projectId`, `ticketId`, or `sourceTypes`. Retrieval only — YOU generate the answer from ' +
        'the returned context. Works without embeddings (keyword-only); message/context_file hits ' +
        'require the conversation:read scope.',
      inputSchema: ragSearchInput.shape,
    },
    async (args) => runTool(() => services.search.rag(actor, args)),
  )

  server.registerTool(
    'add_attachment',
    {
      title: 'Add attachment',
      description:
        'Attach a link to a ticket (logs, designs, docs) by URL, with an optional label. ' +
        'Rooster does not host files — pass a URL to an externally hosted resource.',
      inputSchema: addAttachmentInput.shape,
    },
    async (args) => runTool(() => services.attachments.add(actor, args)),
  )

  server.registerTool(
    'list_attachments',
    {
      title: 'List attachments',
      description: "List a ticket's attachments (links).",
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.attachments.list(actor, ticketId)),
  )

  server.registerTool(
    'remove_attachment',
    {
      title: 'Remove attachment',
      description: 'Remove an attachment from a ticket by its id.',
      inputSchema: removeAttachmentInput.shape,
    },
    async (args) => runTool(() => services.attachments.remove(actor, args)),
  )

  server.registerTool(
    'find_by_label',
    {
      title: 'Find by tag',
      description:
        'Find related tickets across the org that carry a given label/tag (exact tag match). ' +
        'For meaning-based recall, prefer find_similar_tickets when semantic search is available. ' +
        'Set `compact: true` for the trimmed board-scan shape.',
      inputSchema: { label: z.string().min(1).max(60), compact: z.boolean().optional() },
    },
    async ({ label, compact }) => {
      const res = await runTool(async () =>
        maybeCompact(await services.tickets.findByLabel(actor, label), compact),
      )
      return semanticSearch ? withHint(res, SEMANTIC_HINT) : res
    },
  )

  server.registerTool(
    'search_tickets',
    {
      title: 'Search tickets',
      description:
        'Relevance-ranked full-text search across ticket titles and descriptions in your org — ' +
        'EXACT keyword match (stemmed: "deploy" matches "deploying"; title matches rank highest). ' +
        'For meaning-based recall (related work, similar issues, prior decisions), prefer ' +
        'find_similar_tickets / rag_search when semantic search is configured. ' +
        'Set `compact: true` for the trimmed board-scan shape.',
      inputSchema: { query: z.string().min(1).max(200), compact: z.boolean().optional() },
    },
    async ({ query, compact }) => {
      const res = await runTool(async () =>
        maybeCompact(await services.tickets.search(actor, query), compact),
      )
      return semanticSearch ? withHint(res, SEMANTIC_HINT) : res
    },
  )

  server.registerTool(
    'find_similar_tickets',
    {
      title: 'Find similar tickets',
      description:
        'Semantic search: tickets across your workspace most similar in MEANING to a query ' +
        '(vector embeddings), not just keyword matches. Spans all projects by default; pass ' +
        '`projectId` to scope to one project (recommended in a multi-project workspace, where ' +
        'cross-project matches can otherwise crowd out the one you mean). Use it to recall ' +
        'related prior work/decisions. Requires embeddings to be configured; otherwise returns ' +
        'an error. Set `compact: true` for the trimmed shape.',
      inputSchema: {
        query: z.string().min(1).max(1000),
        limit: z.number().int().min(1).max(50).optional(),
        projectId: z.uuid().optional(),
        compact: z.boolean().optional(),
      },
    },
    async ({ query, limit, projectId, compact }) =>
      runTool(async () =>
        maybeCompact(await services.tickets.findSimilar(actor, query, limit, projectId), compact),
      ),
  )

  server.registerTool(
    'backfill_embeddings',
    {
      title: 'Backfill embeddings',
      description:
        'Embed any tickets that lack an embedding (e.g. created before embeddings were ' +
        'configured) so they become findable by find_similar_tickets. Optionally scope to one ' +
        'project. Requires embeddings to be configured. Returns `{ embedded, failed, ' +
        'failedProjects }` — `embedded` counts vectors actually stored, `failed` counts store ' +
        'failures, and `failedProjects` lists projects whose read failed after retries (a ' +
        'per-project failure is isolated, not fatal). Re-run to finish any that failed.',
      inputSchema: { projectId: z.uuid().optional() },
    },
    async ({ projectId }) => runTool(() => services.tickets.backfillEmbeddings(actor, projectId)),
  )

  server.registerTool(
    'list_subtasks',
    {
      title: 'List subtasks',
      description: 'List the direct subtasks (children) of a ticket.',
      inputSchema: { parentId: z.uuid() },
    },
    async ({ parentId }) => runTool(() => services.tickets.listSubtasks(actor, parentId)),
  )

  server.registerTool(
    'link_tickets',
    {
      title: 'Link tickets',
      description:
        'Relate two tickets with a directed link: type "blocks" (from blocks to), ' +
        '"duplicates" (from duplicates to), or "relates" (symmetric). The inverse ' +
        '(blocked-by / duplicated-by) is derived automatically; blocks links may not form a cycle.',
      inputSchema: linkTicketsInput.shape,
    },
    async (args) => runTool(() => services.tickets.link(actor, args)),
  )

  server.registerTool(
    'unlink_tickets',
    {
      title: 'Unlink tickets',
      description:
        'Remove a directed link previously created with link_tickets (same from/to/type).',
      inputSchema: unlinkTicketsInput.shape,
    },
    async (args) => runTool(() => services.tickets.unlink(actor, args)),
  )

  server.registerTool(
    'list_links',
    {
      title: 'List links',
      description:
        "List a ticket's relationships from its own perspective (blocks, blocked_by, " +
        "relates, duplicates, duplicated_by), each with the other ticket's key + title.",
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.tickets.listLinks(actor, ticketId)),
  )

  server.registerTool(
    'watch_ticket',
    {
      title: 'Watch ticket',
      description:
        'Follow a ticket — you (or your agent) get notified on status, assignee, and comment ' +
        'changes. Idempotent. Being assigned or commenting also auto-follows.',
      inputSchema: watchTicketInput.shape,
    },
    async (args) => runTool(() => services.watchers.watch(actor, args)),
  )

  server.registerTool(
    'unwatch_ticket',
    {
      title: 'Unwatch ticket',
      description: 'Stop following a ticket.',
      inputSchema: watchTicketInput.shape,
    },
    async (args) => runTool(() => services.watchers.unwatch(actor, args)),
  )

  server.registerTool(
    'list_watchers',
    {
      title: 'List watchers',
      description: 'List the principals following a ticket.',
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.watchers.listWatchers(actor, ticketId)),
  )

  server.registerTool(
    'my_watches',
    {
      title: 'My watched tickets',
      description: 'List the tickets you (the calling principal) are following.',
      inputSchema: {},
    },
    async () => runTool(() => services.watchers.myWatches(actor)),
  )

  server.registerTool(
    'crow',
    {
      title: 'Crow (notify assignee)',
      description: 'Wake/notify the agent assigned to a ticket — the outbound notification verb.',
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.tickets.crow(actor, ticketId)),
  )

  server.registerTool(
    'invite_member',
    {
      title: 'Invite teammate',
      description:
        'Invite a human teammate into your workspace by email (admin only). They join the shared workspace; their account links on first login. Re-inviting an existing member updates their role.',
      inputSchema: inviteMemberInput.shape,
    },
    async (args) => runTool(() => services.members.invite(actor, args)),
  )

  server.registerTool(
    'create_invite',
    {
      title: 'Create invite code',
      description:
        'Mint a shareable workspace join code (admin only). Share it with a teammate; they redeem it with join_tenant on first connect to join at the given role.',
      inputSchema: createInviteInput.shape,
    },
    async (args) => runTool(() => services.invites.create(actor, args)),
  )

  server.registerTool(
    'read_audit',
    {
      title: 'Read audit log',
      description:
        'Read the append-only audit log for your org (admin only) — who did what, attributed to the trusted principal.',
      inputSchema: { limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ limit }) => runTool(() => services.audit.list(actor, { limit })),
  )

  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description: 'List the agents registered in your org.',
      inputSchema: {},
    },
    async () => runTool(() => services.agents.list(actor)),
  )

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description:
        'Register a new agent in your org (admin only). Returns the agent; bind its OAuth client separately once registered.',
      inputSchema: registerAgentInput.shape,
    },
    async (args) => runTool(() => services.agents.register(actor, args)),
  )

  server.registerTool(
    'set_agent_status',
    {
      title: 'Set agent status',
      description: 'Activate, suspend or revoke an agent (admin only).',
      inputSchema: { id: z.uuid(), status: agentStatusSchema },
    },
    async ({ id, status }) => runTool(() => services.agents.setStatus(actor, id, status)),
  )

  // --- CRM (ROO-46) ---------------------------------------------------------

  server.registerTool(
    'create_customer',
    {
      title: 'Create customer',
      description:
        'Create a customer/client — the long-lived relationship record. `lifecycleStage` ' +
        '(lead|prospect|active|churned) defaults to lead. Add people with add_contact, log ' +
        'calls/notes with log_interaction, and open revenue with create_deal.',
      inputSchema: createCustomerInput.shape,
    },
    async (args) => runTool(() => services.customers.create(actor, args)),
  )

  server.registerTool(
    'list_customers',
    {
      title: 'List customers',
      description: 'List the workspace customers, most recent first.',
      inputSchema: {},
    },
    async () => runTool(() => services.customers.list(actor)),
  )

  server.registerTool(
    'get_customer',
    {
      title: 'Get customer',
      description: 'Fetch a single customer by id.',
      inputSchema: { id: z.uuid() },
    },
    async ({ id }) => runTool(() => services.customers.get(actor, id)),
  )

  server.registerTool(
    'update_customer',
    {
      title: 'Update customer',
      description:
        "Update a customer's fields (name, ownerId, tags). To move the relationship " +
        'lifecycle (lead → prospect → active, churn/re-engage) use change_lifecycle_stage — ' +
        "it's a validated state machine, not a free-form field.",
      inputSchema: { id: z.uuid(), ...updateCustomerInput.shape },
    },
    async ({ id, ...patch }) => runTool(() => services.customers.update(actor, id, patch)),
  )

  server.registerTool(
    'change_lifecycle_stage',
    {
      title: 'Change customer lifecycle stage',
      description:
        'Move a customer through the relationship lifecycle (lead → prospect → active; any ' +
        'stage can churn, and a churned customer can be re-engaged). Validated against the ' +
        'customer workflow — rejects illegal transitions and same-stage no-ops. Distinct from a ' +
        "deal's sales pipeline (change_deal_stage).",
      inputSchema: changeLifecycleStageInput.shape,
    },
    async (args) => runTool(() => services.customers.changeLifecycleStage(actor, args)),
  )

  server.registerTool(
    'add_contact',
    {
      title: 'Add contact',
      description:
        'Add a person (contact) to a customer — name plus optional email/phone/role. Contacts ' +
        'are tracked people, not Rooster principals.',
      inputSchema: createContactInput.shape,
    },
    async (args) => runTool(() => services.contacts.add(actor, args)),
  )

  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description: "List a customer's contacts (people), most recent first.",
      inputSchema: { customerId: z.uuid() },
    },
    async ({ customerId }) => runTool(() => services.contacts.list(actor, customerId)),
  )

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description: "Update a contact's name/email/phone/role.",
      inputSchema: { id: z.uuid(), ...updateContactInput.shape },
    },
    async ({ id, ...patch }) => runTool(() => services.contacts.update(actor, id, patch)),
  )

  server.registerTool(
    'remove_contact',
    {
      title: 'Remove contact',
      description: 'Remove a contact from a customer.',
      inputSchema: { id: z.uuid() },
    },
    async ({ id }) => runTool(() => services.contacts.remove(actor, id)),
  )

  server.registerTool(
    'create_deal',
    {
      title: 'Create deal',
      description:
        'Open a deal (revenue opportunity) under a customer — a ticket-with-a-pipeline. ' +
        '`pipelineStage` (prospecting|qualified|proposal|won|lost) defaults to prospecting. ' +
        '`value` is in minor units (e.g. cents) with a `currency`. One customer can have many ' +
        'deals over time (initial sale, renewals, upsells).',
      inputSchema: createDealInput.shape,
    },
    async (args) => runTool(() => services.deals.create(actor, args)),
  )

  server.registerTool(
    'list_deals',
    {
      title: 'List deals',
      description: "List a customer's deals, most recent first.",
      inputSchema: { customerId: z.uuid() },
    },
    async ({ customerId }) => runTool(() => services.deals.list(actor, customerId)),
  )

  server.registerTool(
    'get_deal',
    {
      title: 'Get deal',
      description: 'Fetch a single deal by id.',
      inputSchema: { id: z.uuid() },
    },
    async ({ id }) => runTool(() => services.deals.get(actor, id)),
  )

  server.registerTool(
    'update_deal',
    {
      title: 'Update deal',
      description:
        "Update a deal's fields (title, value, currency, closeDate, probability, owner, tags). " +
        'Move it through the pipeline with change_deal_stage, not here.',
      inputSchema: { id: z.uuid(), ...updateDealInput.shape },
    },
    async ({ id, ...patch }) => runTool(() => services.deals.update(actor, id, patch)),
  )

  server.registerTool(
    'change_deal_stage',
    {
      title: 'Change deal stage',
      description:
        'Move a deal to a new pipeline stage, validated against the default pipeline ' +
        '(prospecting→qualified→proposal→won/lost; won/lost reopen to earlier stages). Rejects ' +
        'illegal transitions and same-stage no-ops.',
      inputSchema: changeDealStageInput.shape,
    },
    async (args) => runTool(() => services.deals.changeStage(actor, args)),
  )

  server.registerTool(
    'log_interaction',
    {
      title: 'Log interaction',
      description:
        'Record a call/email/note/meeting against a customer, deal, or contact ' +
        '(`targetType` + `targetId`). The body is embedded for RAG recall, so later you can ask ' +
        'rag_search / recall_context "what did we discuss/promise with this customer?" and get ' +
        'grounded, cited history. `occurredAt` defaults to now.',
      inputSchema: logInteractionInput.shape,
    },
    async (args) => runTool(() => services.interactions.log(actor, args)),
  )

  server.registerTool(
    'list_interactions',
    {
      title: 'List interactions',
      description:
        "A target's logged interactions (most recent first). Pass the `targetType` " +
        '(customer|deal|contact) and `targetId`.',
      inputSchema: listInteractionsInput.shape,
    },
    async (args) => runTool(() => services.interactions.list(actor, args)),
  )

  server.registerTool(
    'link_deal_work',
    {
      title: 'Link deal to delivery work',
      description:
        'Attach an existing delivery project to a deal — the won-deal → work bridge that ' +
        'unifies CRM and PM. Create the project first (create_project), then link it here. The ' +
        "project's customer is derived from the deal, so it also shows up in list_customer_work. " +
        'Typically called when a deal moves to `won`, but allowed at any stage.',
      inputSchema: linkDealWorkInput.shape,
    },
    async (args) => runTool(() => services.deals.linkWork(actor, args)),
  )

  server.registerTool(
    'list_deal_work',
    {
      title: 'List deal delivery work',
      description: 'The delivery projects linked to a deal (most recent first).',
      inputSchema: listDealWorkInput.shape,
    },
    async (args) => runTool(() => services.deals.listWork(actor, args)),
  )

  server.registerTool(
    'list_customer_work',
    {
      title: 'List customer delivery work',
      description:
        'Every delivery project serving a customer, across all their deals — the unified view: ' +
        'one relationship, all the work.',
      inputSchema: listCustomerWorkInput.shape,
    },
    async (args) => runTool(() => services.customers.listWork(actor, args)),
  )
}
