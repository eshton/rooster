import { humanIdentityFromSessionEmail } from '@rooster/auth'
import { type Actor, allowedTransitions, CoreError, can } from '@rooster/core'
import type { AgentStatus, TicketStatus } from '@rooster/schema'
import type { Context, Hono } from 'hono'
import type { ServerContext } from '../context.js'
import * as v from './views.js'

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  validation: 400,
  conflict: 409,
}

type Resolved = { actor: Actor } | { noOrg: string } | null

/** Resolve the dashboard session to an actor (or a "signed in, no org" state). */
async function resolveSession(ctx: ServerContext, headers: Headers): Promise<Resolved> {
  const session = await ctx.auth.api.getSession({ headers })
  if (!session) return null
  const identity = await humanIdentityFromSessionEmail(ctx.db.repositories, session.user.email)
  if (!identity) return { noOrg: session.user.email }
  try {
    return { actor: await ctx.services.resolveActor(identity) }
  } catch {
    return { noOrg: session.user.email }
  }
}

/**
 * Mount the human dashboard (server-rendered) under /app. Reads are performed
 * through the core services with the resolved actor, so the same permission
 * checks and tenant scoping apply as for agents.
 */
export function mountDashboard(app: Hono, ctx: ServerContext): void {
  const providers = [
    ctx.config.oauthProviders.github ? 'github' : null,
    ctx.config.oauthProviders.google ? 'google' : null,
  ].filter((p): p is string => p !== null)

  app.get('/app/login', (c) => c.html(v.loginPage({ providers })))
  app.get('/app/signup', (c) => c.html(v.signupPage()))

  // OAuth login resume: better-auth's MCP authorize endpoint redirects an
  // unauthenticated user to `loginPage` (default `/login`) with the original
  // authorize query. We sign them in, then send the browser back to
  // `/api/auth/mcp/authorize?<same query>` so the code is issued and the MCP
  // client's callback fires. (Consent is skipped — no consentPage configured.)
  app.get('/login', (c) => {
    const search = new URL(c.req.raw.url).search
    const next = search ? `/api/auth/mcp/authorize${search}` : '/app'
    return c.html(v.loginPage({ providers, next }))
  })
  app.get('/signup', (c) => {
    const next = c.req.query('next') || '/app'
    return c.html(v.signupPage({ next }))
  })

  // Render a page for the authenticated actor, mapping domain errors to a
  // friendly message page with the right status.
  const page = async (c: Context, render: (actor: Actor) => string | Promise<string>) => {
    const r = await resolveSession(ctx, c.req.raw.headers)
    if (!r) return c.redirect('/app/login')
    if ('noOrg' in r) return c.html(v.noOrgPage(null, r.noOrg))
    try {
      return c.html(await render(r.actor))
    } catch (err) {
      if (err instanceof CoreError) {
        return c.html(
          v.messagePage(r.actor, 'Not available', err.message),
          (STATUS_BY_CODE[err.code] ?? 500) as 400,
        )
      }
      throw err
    }
  }

  app.get('/app', (c) =>
    page(c, async (actor) => {
      const [org, teams, projects] = await Promise.all([
        ctx.services.orgs.get(actor),
        ctx.services.teams.list(actor),
        ctx.services.projects.list(actor),
      ])
      return v.orgOverview({ org, teams, projects, actor })
    }),
  )

  app.get('/app/projects/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const [project, tickets] = await Promise.all([
        ctx.services.projects.get(actor, id),
        ctx.services.tickets.list(actor, id),
      ])
      return v.projectBoard({ project, tickets, actor, canWrite: can(actor, 'ticket:write') })
    }),
  )

  app.get('/app/tickets/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const ticket = await ctx.services.tickets.get(actor, id)
      const comments = await ctx.services.comments.list(actor, id)
      return v.ticketDetail({
        ticket,
        comments,
        actor,
        canWrite: can(actor, 'ticket:write'),
        allowedStatuses: allowedTransitions(ticket.status),
      })
    }),
  )

  app.get('/app/agents', (c) =>
    page(c, async (actor) =>
      v.agentsList({
        agents: await ctx.services.agents.list(actor),
        actor,
        canManage: can(actor, 'agent:write'),
      }),
    ),
  )

  app.get('/app/audit', (c) =>
    page(c, async (actor) => v.auditList({ entries: await ctx.services.audit.list(actor), actor })),
  )

  // --- write actions (POST) -------------------------------------------------

  // Run a mutation for the authenticated actor, then redirect. Domain errors
  // render the friendly message page with the right status.
  const action = async (c: Context, run: (actor: Actor) => Promise<string>) => {
    const r = await resolveSession(ctx, c.req.raw.headers)
    if (!r) return c.redirect('/app/login')
    if ('noOrg' in r) return c.html(v.noOrgPage(null, r.noOrg))
    try {
      return c.redirect(await run(r.actor))
    } catch (err) {
      if (err instanceof CoreError) {
        return c.html(
          v.messagePage(r.actor, 'Action failed', err.message),
          (STATUS_BY_CODE[err.code] ?? 500) as 400,
        )
      }
      throw err
    }
  }

  app.post('/app/projects/:id/tickets', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      const labels = String(body.labels ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      await ctx.services.tickets.create(actor, {
        projectId: id,
        title: String(body.title ?? ''),
        priority: 'none',
        labels,
      })
      return `/app/projects/${id}`
    }),
  )

  app.post('/app/tickets/:id/status', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.tickets.changeStatus(actor, {
        ticketId: id,
        status: String(body.status) as TicketStatus,
      })
      return `/app/tickets/${id}`
    }),
  )

  app.post('/app/tickets/:id/assign', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      const assigneeId = body.assigneeId ? String(body.assigneeId) : null
      await ctx.services.tickets.assign(actor, { ticketId: id, assigneeId })
      return `/app/tickets/${id}`
    }),
  )

  app.post('/app/tickets/:id/comments', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.comments.create(actor, { ticketId: id, body: String(body.body ?? '') })
      return `/app/tickets/${id}`
    }),
  )

  app.post('/app/agents/:id/status', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.agents.setStatus(actor, id, String(body.status) as AgentStatus)
      return '/app/agents'
    }),
  )

  app.post('/app/agents/:id/bind', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.agents.bindOAuthClient(actor, id, String(body.clientId ?? ''))
      return '/app/agents'
    }),
  )
}
