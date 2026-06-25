import { resolveMcpIdentity } from '@rooster/auth'
import { CoreError } from '@rooster/core'
import { createRoosterMcpServer, handleStatelessMcpRequest } from '@rooster/mcp'
import { Hono } from 'hono'
import type { ServerContext } from './context.js'
import { discoveryDocument, landingHtml, llmsText } from './discovery.js'

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  validation: 400,
  conflict: 409,
}

function errorResponse(err: unknown): Response {
  if (err instanceof CoreError) {
    return Response.json(
      { error: err.code, message: err.message },
      { status: STATUS_BY_CODE[err.code] ?? 500 },
    )
  }
  return Response.json({ error: 'internal', message: 'Unexpected error' }, { status: 500 })
}

/**
 * Build the Rooster HTTP app: discovery + agent docs, the better-auth handler
 * (human login + MCP OAuth 2.1 server) and the MCP endpoint. The same Hono app
 * runs on Node, Vercel and Cloudflare via their respective adapters.
 */
export function createApp(ctx: ServerContext): Hono {
  const app = new Hono()

  app.get('/', (c) => c.html(landingHtml(ctx)))
  app.get('/.well-known/rooster', (c) => c.json(discoveryDocument(ctx)))
  app.get('/llms.txt', (c) => c.text(llmsText(ctx)))
  app.get('/healthz', (c) => c.json({ ok: true }))

  // All better-auth routes (OAuth metadata, DCR, token, social login, sessions).
  app.all('/api/auth/*', (c) => ctx.auth.handler(c.req.raw))

  // The MCP endpoint: authenticate the bearer token to a trusted actor, then
  // serve one stateless MCP request bound to that actor.
  app.all('/mcp', async (c) => {
    const req = c.req.raw
    try {
      const identity = await resolveMcpIdentity(ctx.auth, ctx.db.repositories, req.headers)
      if (!identity) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${ctx.config.baseUrl}/api/auth/.well-known/oauth-protected-resource"`,
          },
        })
      }
      const actor = await ctx.services.resolveActor(identity)
      const server = createRoosterMcpServer({ services: ctx.services, actor })
      return await handleStatelessMcpRequest(server, req)
    } catch (err) {
      return errorResponse(err)
    }
  })

  return app
}
