import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolDeps } from './tools.js'

/**
 * Register read-only resources. Resources mirror tool reads but are addressable
 * by URI so clients can subscribe to / reference board state directly:
 *   - `ticket://{key}`   a single ticket by key (e.g. ticket://ROOST-42)
 *   - `project://{id}`   a project's metadata
 */
export function registerResources(server: McpServer, { services, actor }: ToolDeps): void {
  server.registerResource(
    'ticket',
    new ResourceTemplate('ticket://{key}', { list: undefined }),
    {
      title: 'Ticket',
      description: 'A single ticket addressed by its key.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const key = String(variables.key)
      const ticket = await services.tickets.getByKey(actor, key)
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(ticket, null, 2) },
        ],
      }
    },
  )

  server.registerResource(
    'project',
    new ResourceTemplate('project://{id}', { list: undefined }),
    {
      title: 'Project',
      description: 'A project addressed by its id.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const project = await services.projects.get(actor, String(variables.id))
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(project, null, 2) },
        ],
      }
    },
  )
}
