import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerResources } from './resources.js'
import { registerTools, type ToolDeps } from './tools.js'

export type { ToolDeps as McpServerDeps }

/**
 * Build a Rooster MCP server bound to a single authenticated actor. In the
 * stateless Streamable-HTTP deployment one server is created per request after
 * the transport resolves the bearer token to an actor.
 */
export function createRoosterMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: 'rooster', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  )
  registerTools(server, deps)
  registerResources(server, deps)
  return server
}

/**
 * Handle one MCP request over a stateless Web-standard Streamable-HTTP
 * transport. Runs on Node 18+, Vercel and Cloudflare Workers unchanged.
 */
export async function handleStatelessMcpRequest(
  server: McpServer,
  request: Request,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  await server.connect(transport)
  const response = await transport.handleRequest(request)
  transport.onclose = () => {
    void server.close()
  }
  return response
}
