import { resolveMcpIdentity } from '@rooster/auth'
import { CoreError, provisionTenant } from '@rooster/core'
import { createRoosterMcpServer, handleStatelessMcpRequest } from '@rooster/mcp'
import { registerTenantInput } from '@rooster/schema'
import { Hono } from 'hono'
import type { ServerContext } from './context.js'
import { discoveryDocument, landingHtml, llmsText } from './discovery.js'
import { signupAllowed } from './gate.js'
import { RateLimiter } from './rate-limit.js'

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
  const mcpRateLimiter = new RateLimiter(ctx.config.mcp.rateLimitPerMinute)

  app.get('/', (c) => c.html(landingHtml(ctx)))
  app.get('/.well-known/rooster', (c) => c.json(discoveryDocument(ctx)))
  app.get('/llms.txt', (c) => c.text(llmsText(ctx)))
  app.get('/healthz', (c) => c.json({ ok: true }))

  // Agent-first, gated tenant self-registration: provision org+team+project
  // (+ optional first owning agent) in one call. Gated by the signup token on
  // a hosted instance; open when no token is configured (self-host).
  app.post('/onboard', async (c) => {
    const parsed = registerTenantInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: 'validation', issues: parsed.error.issues }, 400)
    }
    if (!signupAllowed(ctx.config.onboarding.signupToken, parsed.data.signupToken)) {
      return c.json({ error: 'forbidden', message: 'Invalid or missing signup token' }, 403)
    }
    const { signupToken: _omit, ...spec } = parsed.data
    try {
      const result = await provisionTenant(ctx.services, spec)
      return c.json(
        {
          org: { id: result.org.id, slug: result.org.slug, name: result.org.name },
          team: { id: result.team.id, key: result.team.key },
          project: { id: result.project.id, name: result.project.name },
          agent: result.agent
            ? { id: result.agent.id, principalId: result.agent.principalId }
            : null,
          mcpEndpoint: `${ctx.config.baseUrl}/mcp`,
        },
        201,
      )
    } catch (err) {
      return errorResponse(err)
    }
  })

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
      // Per-agent rate limiting (keyed by the trusted principal).
      const rl = mcpRateLimiter.check(identity.principalId, Date.now())
      if (!rl.allowed) {
        return new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: {
            'content-type': 'application/json',
            'Retry-After': String(rl.retryAfterSeconds),
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
