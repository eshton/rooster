import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type Actor,
  type ProvisionalIdentity,
  provisionTenantForAccount,
  type Services,
} from '@rooster/core'
import {
  agentStatusSchema,
  assignTicketInput,
  changeStatusInput,
  commentInput,
  createTenantInput,
  createTicketInput,
  registerAgentInput,
  updateTicketInput,
} from '@rooster/schema'
import { z } from 'zod'
import { errorResult, jsonResult, runTool } from './result.js'

export interface ToolDeps {
  services: Services
  actor: Actor
}

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
          project: { id: result.project.id, name: result.project.name },
          message: `Workspace '${result.org.name}' is ready. Create tickets in '${result.project.name}' — they'll be keyed ${result.team.key}-1, ${result.team.key}-2, …`,
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
export function registerTools(server: McpServer, { services, actor }: ToolDeps): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        "Return the calling agent's trusted identity (principal id, org, role) and granted scopes.",
      inputSchema: {},
    },
    async () =>
      jsonResult({
        orgId: actor.orgId,
        principalId: actor.principalId,
        type: actor.type,
        role: actor.role,
        scopes: actor.scopes,
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
    'list_tickets',
    {
      title: 'List tickets',
      description: 'List tickets in a project.',
      inputSchema: { projectId: z.uuid() },
    },
    async ({ projectId }) => runTool(() => services.tickets.list(actor, projectId)),
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
    'create_ticket',
    {
      title: 'Create ticket',
      description:
        'Create a ticket. Always add relevant `labels` (tags) so related work is easy to find later, and set `parentId` when this is a subtask of another ticket.',
      inputSchema: createTicketInput.shape,
    },
    async (args) => runTool(() => services.tickets.create(actor, args)),
  )

  server.registerTool(
    'update_ticket',
    {
      title: 'Update ticket',
      description:
        "Update a ticket's fields (title, description, priority, labels, assignee, parent).",
      inputSchema: { id: z.uuid(), ...updateTicketInput.shape },
    },
    async ({ id, ...patch }) => runTool(() => services.tickets.update(actor, id, patch)),
  )

  server.registerTool(
    'change_status',
    {
      title: 'Change status',
      description: 'Move a ticket to a new status (validated against the workflow).',
      inputSchema: changeStatusInput.shape,
    },
    async (args) => runTool(() => services.tickets.changeStatus(actor, args)),
  )

  server.registerTool(
    'assign_ticket',
    {
      title: 'Assign ticket',
      description: 'Assign a ticket to a principal (user or agent), or pass null to unassign.',
      inputSchema: assignTicketInput.shape,
    },
    async (args) => runTool(() => services.tickets.assign(actor, args)),
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
    'find_by_label',
    {
      title: 'Find by tag',
      description: 'Find related tickets across the org that carry a given label/tag.',
      inputSchema: { label: z.string().min(1).max(60) },
    },
    async ({ label }) => runTool(() => services.tickets.findByLabel(actor, label)),
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
    'crow',
    {
      title: 'Crow (notify assignee)',
      description: 'Wake/notify the agent assigned to a ticket — the outbound notification verb.',
      inputSchema: { ticketId: z.uuid() },
    },
    async ({ ticketId }) => runTool(() => services.tickets.crow(actor, ticketId)),
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
}
