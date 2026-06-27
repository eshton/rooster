import { resolveMcpIdentity } from '@rooster/auth'
import { CoreError, isProvisional, provisionTenant } from '@rooster/core'
import { createRoosterMcpServer, handleStatelessMcpRequest } from '@rooster/mcp'
import { type ClientInfo, registerTenantInput } from '@rooster/schema'
import { Hono } from 'hono'
import type { ServerContext } from './context.js'
import { mountDashboard } from './dashboard/routes.js'
import { discoveryDocument, landingHtml, llmsText } from './discovery.js'
import { signupAllowed } from './gate.js'
import { DbRateLimiter } from './rate-limit.js'

/**
 * Best-effort capture of the calling MCP client's identity for the audit log
 * (untrusted, display-only). Prefers the structured `clientInfo` from an MCP
 * `initialize` body; falls back to the HTTP `User-Agent`, which — unlike the
 * MCP clientInfo — is present on every request including stateless tool calls.
 */
export async function extractClientInfo(req: Request): Promise<ClientInfo | null> {
  try {
    const body = (await req.clone().json()) as { params?: { clientInfo?: ClientInfo } }
    const ci = body?.params?.clientInfo
    if (ci?.name) {
      return { name: String(ci.name).slice(0, 200), version: String(ci.version ?? '').slice(0, 60) }
    }
  } catch {
    // not a JSON body (e.g. a GET/SSE request) — fall through to User-Agent
  }
  const ua = req.headers.get('user-agent')
  return ua ? { name: ua.slice(0, 200), version: '' } : null
}

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
  const mcpRateLimiter = new DbRateLimiter(ctx.db.repositories, ctx.config.mcp.rateLimitPerMinute)

  app.get('/', (c) => c.html(landingHtml(ctx)))
  app.get('/favicon.svg', (c) =>
    c.body(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1c1917"/><path d="M30 12c3-4 8-4 9 1 4-3 9-1 8 4 4-1 7 3 4 7l-21 2z" fill="#ef4444"/><path d="M24 20c10-4 20 1 21 12 1 9-5 17-14 18-2 6-8 6-9 0-7-1-11-7-9-14 1-5 5-9 11-12-1-3 0-3 0-4z" fill="#d97706"/><path d="M45 30l11 3-11 4z" fill="#fbbf24"/><circle cx="34" cy="29" r="2.6" fill="#1c1917"/><path d="M40 41c0 5-2 8-5 8 1-4 1-6 0-9z" fill="#ef4444"/></svg>`,
      200,
      { 'content-type': 'image/svg+xml' },
    ),
  )
  app.get('/.well-known/rooster', (c) => c.json(discoveryDocument(ctx)))
  // Human dashboard (server-rendered) under /app.
  mountDashboard(app, ctx)
  app.get('/llms.txt', (c) => c.text(llmsText(ctx)))
  app.get('/healthz', (c) => c.json({ ok: true }))

  // OAuth discovery aliases. better-auth advertises the issuer as the host root
  // but serves its metadata under /api/auth; MCP/OAuth clients (per RFC 8414)
  // then fetch `<root>/.well-known/oauth-authorization-server` and 404. Mirror
  // the root well-known paths to the better-auth handler so discovery resolves.
  for (const wk of [
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
  ]) {
    app.get(wk, (c) => {
      const target = new URL(c.req.raw.url)
      target.pathname = `/api/auth${wk}`
      return ctx.auth.handler(new Request(target, { method: 'GET', headers: c.req.raw.headers }))
    })
  }

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
          project: { id: result.project.id, name: result.project.name, key: result.project.key },
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

  // Closed-signup mode (internal teams / single-user self-host): reject public
  // email/password registration before it reaches better-auth. New members then
  // join only by invite. Gated in the transport (like the onboarding token),
  // not in better-auth, so the first-run admin bootstrap's server-side
  // `signUpEmail` still works. Social/OAuth sign-up is governed by which
  // providers you configure.
  if (ctx.config.onboarding.disableSignup) {
    app.post('/api/auth/sign-up/email', (c) =>
      c.json(
        { error: 'signup_disabled', message: 'Public sign-up is disabled on this instance.' },
        403,
      ),
    )
  }

  // All better-auth routes (OAuth metadata, DCR, token, social login, sessions).
  app.all('/api/auth/*', (c) => ctx.auth.handler(c.req.raw))

  // The MCP endpoint: authenticate the bearer token to a trusted actor, then
  // serve one stateless MCP request bound to that actor.
  app.all('/mcp', async (c) => {
    const req = c.req.raw
    try {
      const clientInfo = await extractClientInfo(req)
      // A multi-workspace human can select which org to act in per request.
      const desiredOrgId = req.headers.get('x-rooster-org')
      const identity = await resolveMcpIdentity(
        ctx.auth,
        ctx.db.repositories,
        req.headers,
        clientInfo,
        desiredOrgId,
      )
      if (!identity) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401,
          headers: {
            'content-type': 'application/json',
            'WWW-Authenticate': `Bearer resource_metadata="${ctx.config.baseUrl}/api/auth/.well-known/oauth-protected-resource"`,
          },
        })
      }

      // An authenticated-but-orgless caller gets the minimal bootstrap server
      // (whoami + create_tenant); rate-limit by the stable account id.
      if (isProvisional(identity)) {
        const rl = await mcpRateLimiter.check(identity.authUserId, Date.now())
        if (!rl.allowed) {
          return new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'Retry-After': String(rl.retryAfterSeconds),
            },
          })
        }
        const server = createRoosterMcpServer({ services: ctx.services, provisional: identity })
        return await handleStatelessMcpRequest(server, req)
      }

      // Per-principal rate limiting (keyed by the trusted principal).
      const rl = await mcpRateLimiter.check(identity.principalId, Date.now())
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
