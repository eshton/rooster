import { humanIdentityFromSessionEmail, listUserOrgs } from '@rooster/auth'
import { type Actor, allowedTransitions, CoreError, can } from '@rooster/core'
import type {
  AgentStatus,
  CustomerLifecycleStage,
  DealPipelineStage,
  EstimatePoints,
  InteractionKind,
  Role,
  TicketPriority,
  TicketStatus,
} from '@rooster/schema'
import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { ServerContext } from '../context.js'
import * as v from './views.js'

/** Cookie that pins which workspace a multi-org user is currently acting in. */
const ACTIVE_ORG_COOKIE = 'rooster_org'

/** Distinguishes a raw ticket UUID from a human-readable key in URLs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  validation: 400,
  conflict: 409,
}

type Resolved = { actor: Actor } | { noOrg: string } | null

/** Resolve the dashboard session to an actor (or a "signed in, no org" state). */
async function resolveSession(ctx: ServerContext, c: Context): Promise<Resolved> {
  const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers })
  if (!session) return null
  const activeOrgId = getCookie(c, ACTIVE_ORG_COOKIE) ?? null
  const identity = await humanIdentityFromSessionEmail(
    ctx.db.repositories,
    session.user.email,
    activeOrgId,
  )
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
  // Configurable CRM display label (Customer / Client / Account); the nav label
  // is a module singleton so set it once here.
  const crm = ctx.config.crm
  v.setBranding({ crmLabelPlural: crm.labelPlural })

  // One login button per configured OAuth provider (order is stable + sensible).
  const providers = (
    ['github', 'google', 'microsoft', 'apple', 'discord', 'gitlab'] as const
  ).filter((p) => ctx.config.oauthProviders[p])

  const allowSignup = !ctx.config.onboarding.disableSignup
  const signupClosed = (c: Context) =>
    c.html(
      v.messagePage(
        null,
        'Sign-up is invite-only',
        'This Rooster instance has public sign-up disabled. Ask an admin for an invite, then sign in.',
      ),
      403,
    )

  app.get('/app/login', (c) => c.html(v.loginPage({ providers, allowSignup })))
  app.get('/app/signup', (c) => (allowSignup ? c.html(v.signupPage()) : signupClosed(c)))

  // Password reset (email/password accounts). The reset link emailed by
  // better-auth points back to `/app/reset-password?token=…`.
  app.get('/app/forgot-password', (c) =>
    c.html(v.forgotPasswordPage({ sent: c.req.query('sent') === '1' })),
  )
  app.get('/app/reset-password', (c) => {
    // better-auth signals an invalid/expired token via `?error=…`.
    const error = c.req.query('error')
    return c.html(
      v.resetPasswordPage({
        token: error ? undefined : c.req.query('token'),
        error: error ? 'This reset link is invalid or has expired.' : undefined,
      }),
    )
  })

  // OAuth login resume: better-auth's MCP authorize endpoint redirects an
  // unauthenticated user to `loginPage` (default `/login`) with the original
  // authorize query. We sign them in, then send the browser back to
  // `/api/auth/mcp/authorize?<same query>` so the code is issued and the MCP
  // client's callback fires. (Consent is skipped — no consentPage configured.)
  app.get('/login', (c) => {
    const search = new URL(c.req.raw.url).search
    const next = search ? `/api/auth/mcp/authorize${search}` : '/app'
    return c.html(v.loginPage({ providers, next, allowSignup }))
  })
  app.get('/signup', (c) => {
    if (!allowSignup) return signupClosed(c)
    const next = c.req.query('next') || '/app'
    return c.html(v.signupPage({ next }))
  })

  // Render a page for the authenticated actor, mapping domain errors to a
  // friendly message page with the right status.
  const page = async (c: Context, render: (actor: Actor) => string | Promise<string>) => {
    const r = await resolveSession(ctx, c)
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

  // Cross-workspace switcher. `?org=<id>` pins the active workspace (if the
  // user is a member) via a cookie and redirects to the overview; with no
  // query it lists every workspace the account belongs to.
  app.get('/app/switch', async (c) => {
    const session = await ctx.auth.api.getSession({ headers: c.req.raw.headers })
    if (!session) return c.redirect('/app/login')
    const memberships = await listUserOrgs(ctx.db.repositories, session.user.email)
    if (memberships.length === 0) return c.html(v.noOrgPage(null, session.user.email))

    const target = c.req.query('org')
    if (target) {
      if (!memberships.some((m) => m.orgId === target)) {
        return c.html(
          v.messagePage(null, 'Not a member', 'You do not belong to that workspace.'),
          403,
        )
      }
      setCookie(c, ACTIVE_ORG_COOKIE, target, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 60 * 60 * 24 * 365,
      })
      return c.redirect('/app')
    }

    return page(c, async (actor) => {
      const orgs = await Promise.all(
        memberships.map(async (m) => {
          const org = await ctx.db.repositories.orgs.getById(m.orgId)
          return org ? { id: org.id, name: org.name, slug: org.slug } : null
        }),
      )
      return v.switchWorkspacePage(
        actor,
        orgs.filter((o): o is { id: string; name: string; slug: string } => o !== null),
      )
    })
  })

  app.get('/app', (c) =>
    page(c, async (actor) => {
      const [org, teams, projects, members, agents] = await Promise.all([
        ctx.services.orgs.get(actor),
        ctx.services.teams.list(actor),
        ctx.services.projects.list(actor),
        ctx.services.members.listOrg(actor),
        ctx.services.agents.list(actor),
      ])
      const ticketLists = await Promise.all(
        projects.map((p) => ctx.services.tickets.list(actor, p.id, { limit: 200 })),
      )
      const allTickets = ticketLists.flat()
      const open = allTickets.filter((t) => t.status !== 'done' && t.status !== 'canceled').length
      const recent = [...allTickets]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 6)
      const projectNames = Object.fromEntries(projects.map((p) => [p.id, p.name]))
      return v.orgOverview({
        org,
        teams,
        projects,
        actor,
        stats: {
          tickets: allTickets.length,
          open,
          people: members.filter((m) => m.type === 'user').length,
          agents: agents.length,
        },
        recent,
        projectNames,
        canCreateTeam: can(actor, 'team:write'),
        canCreateProject: can(actor, 'project:write'),
      })
    }),
  )

  // Build a principalId → display-name map for resolving assignees/authors.
  const toNames = (members: { principalId: string; displayName: string }[]) =>
    Object.fromEntries(members.map((m) => [m.principalId, m.displayName]))

  // Ticket URLs use the human-readable key (e.g. /app/tickets/ROOST-1). Accept
  // either a key (case-insensitive) or a raw UUID so old links keep working.
  const resolveTicket = (actor: Actor, ref: string) =>
    UUID_RE.test(ref)
      ? ctx.services.tickets.get(actor, ref)
      : ctx.services.tickets.getByKey(actor, ref.toUpperCase())

  // Parse the estimate form field: blank → null (unsized), otherwise the number.
  // The dashboard <select> only offers on-scale values; an off-scale value from a
  // raw POST is left for the DTO/service to reject (the single enforcement point),
  // so the cast here is safe — it isn't where the scale is validated.
  const estimateOf = (raw: unknown): EstimatePoints | null => {
    const s = String(raw ?? '').trim()
    if (s === '') return null
    const n = Number(s)
    return (Number.isFinite(n) ? n : null) as EstimatePoints | null
  }

  app.get('/app/projects/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const status = c.req.query('status') as TicketStatus | undefined
      const [project, tickets, members] = await Promise.all([
        ctx.services.projects.get(actor, id),
        ctx.services.tickets.list(actor, id, status ? { status } : undefined),
        ctx.services.members.listOrg(actor),
      ])
      return v.projectBoard({
        project,
        tickets,
        actor,
        canWrite: can(actor, 'ticket:write'),
        names: toNames(members),
        status: status ?? null,
      })
    }),
  )

  app.get('/app/tickets/:id', (c) =>
    page(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const [comments, attachments, members] = await Promise.all([
        ctx.services.comments.list(actor, ticket.id),
        ctx.services.attachments.list(actor, ticket.id),
        ctx.services.members.listOrg(actor),
      ])
      return v.ticketDetail({
        ticket,
        comments,
        attachments,
        actor,
        canWrite: can(actor, 'ticket:write'),
        allowedStatuses: allowedTransitions(ticket.status),
        members,
        names: toNames(members),
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

  app.get('/app/mine', (c) =>
    page(c, async (actor) =>
      v.ticketListPage({
        title: 'My tickets',
        tickets: await ctx.services.tickets.myTickets(actor),
        actor,
      }),
    ),
  )

  app.get('/app/search', (c) =>
    page(c, async (actor) => {
      const q = c.req.query('q') ?? ''
      const tickets = q ? await ctx.services.tickets.search(actor, q) : []
      return v.ticketListPage({ title: 'Search', tickets, actor, query: q, search: true })
    }),
  )

  app.get('/app/members', (c) =>
    page(c, async (actor) =>
      v.membersPage({
        members: await ctx.services.members.listOrg(actor),
        actor,
        canManage: can(actor, 'team:write'),
        inviteCode: c.req.query('code') ?? null,
      }),
    ),
  )

  // --- CRM (ROO-51) ---------------------------------------------------------

  app.get('/app/customers', (c) =>
    page(c, async (actor) =>
      v.customersList({
        actor,
        customers: await ctx.services.customers.list(actor),
        label: crm.label,
        labelPlural: crm.labelPlural,
        canWrite: can(actor, 'crm:write'),
      }),
    ),
  )

  app.get('/app/customers/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const [customer, contacts, deals, interactions, work, members] = await Promise.all([
        ctx.services.customers.get(actor, id),
        ctx.services.contacts.list(actor, id),
        ctx.services.deals.list(actor, id),
        ctx.services.interactions.list(actor, { targetType: 'customer', targetId: id }),
        ctx.services.customers.listWork(actor, { customerId: id }),
        ctx.services.members.listOrg(actor),
      ])
      const names = Object.fromEntries(members.map((m) => [m.principalId, m.displayName]))
      return v.customerDetail({
        actor,
        customer,
        contacts,
        deals,
        interactions,
        work,
        names,
        label: crm.label,
        canWrite: can(actor, 'crm:write'),
      })
    }),
  )

  app.get('/app/deals/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const deal = await ctx.services.deals.get(actor, id)
      const [customer, work, projects] = await Promise.all([
        ctx.services.customers.get(actor, deal.customerId),
        ctx.services.deals.listWork(actor, { dealId: id }),
        ctx.services.projects.list(actor),
      ])
      return v.dealDetail({
        actor,
        deal,
        customer,
        work,
        projects,
        label: crm.label,
        canWrite: can(actor, 'crm:write'),
      })
    }),
  )

  // --- write actions (POST) -------------------------------------------------

  // Run a mutation for the authenticated actor, then redirect. Domain errors
  // render the friendly message page with the right status.
  const action = async (c: Context, run: (actor: Actor) => Promise<string>) => {
    const r = await resolveSession(ctx, c)
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
        priority: (body.priority ? String(body.priority) : 'none') as TicketPriority,
        labels,
        dueDate: body.dueDate ? String(body.dueDate) : null,
        startDate: body.startDate ? String(body.startDate) : null,
        estimate: estimateOf(body.estimate),
      })
      return `/app/projects/${id}`
    }),
  )

  app.post('/app/tickets/:id/update', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const body = await c.req.parseBody()
      const labels = String(body.labels ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      await ctx.services.tickets.update(actor, ticket.id, {
        title: String(body.title ?? ''),
        description: body.description ? String(body.description) : null,
        priority: (body.priority ? String(body.priority) : 'none') as TicketPriority,
        labels,
        dueDate: body.dueDate ? String(body.dueDate) : null,
        startDate: body.startDate ? String(body.startDate) : null,
        estimate: estimateOf(body.estimate),
      })
      return `/app/tickets/${ticket.key}`
    }),
  )

  app.post('/app/tickets/:id/status', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const body = await c.req.parseBody()
      await ctx.services.tickets.changeStatus(actor, {
        ticketId: ticket.id,
        status: String(body.status) as TicketStatus,
      })
      return `/app/tickets/${ticket.key}`
    }),
  )

  app.post('/app/tickets/:id/assign', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const body = await c.req.parseBody()
      const assigneeId = body.assigneeId ? String(body.assigneeId) : null
      await ctx.services.tickets.assign(actor, { ticketId: ticket.id, assigneeId })
      return `/app/tickets/${ticket.key}`
    }),
  )

  app.post('/app/tickets/:id/comments', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const body = await c.req.parseBody()
      await ctx.services.comments.create(actor, {
        ticketId: ticket.id,
        body: String(body.body ?? ''),
      })
      return `/app/tickets/${ticket.key}`
    }),
  )

  app.post('/app/tickets/:id/attachments', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      const body = await c.req.parseBody()
      const label = String(body.label ?? '').trim()
      await ctx.services.attachments.add(actor, {
        ticketId: ticket.id,
        url: String(body.url ?? ''),
        label: label === '' ? undefined : label,
      })
      return `/app/tickets/${ticket.key}`
    }),
  )

  app.post('/app/tickets/:id/attachments/:attachmentId/remove', (c) =>
    action(c, async (actor) => {
      const ticket = await resolveTicket(actor, c.req.param('id'))
      await ctx.services.attachments.remove(actor, {
        attachmentId: c.req.param('attachmentId'),
      })
      return `/app/tickets/${ticket.key}`
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

  app.post('/app/teams', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      const key = String(body.key ?? '')
        .trim()
        .toUpperCase()
      await ctx.services.teams.create(actor, {
        key: key === '' ? undefined : key,
        name: String(body.name ?? ''),
      })
      return '/app'
    }),
  )

  app.post('/app/projects', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      await ctx.services.projects.create(actor, {
        teamId: String(body.teamId ?? ''),
        key: String(body.key ?? '')
          .trim()
          .toUpperCase(),
        name: String(body.name ?? ''),
        description: body.description ? String(body.description) : undefined,
      })
      return '/app'
    }),
  )

  app.post('/app/members/invite', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      await ctx.services.members.invite(actor, {
        email: String(body.email ?? ''),
        role: String(body.role ?? 'member') as 'viewer' | 'member' | 'admin',
      })
      return '/app/members'
    }),
  )

  app.post('/app/members/role', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      await ctx.services.members.upsert(actor, {
        principalId: String(body.principalId ?? ''),
        teamId: null,
        role: String(body.role ?? 'member') as Role,
      })
      return '/app/members'
    }),
  )

  app.post('/app/members/code', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      const invite = await ctx.services.invites.create(actor, {
        role: String(body.role ?? 'member') as 'viewer' | 'member' | 'admin',
        maxUses: 1,
      })
      return `/app/members?code=${encodeURIComponent(invite.code)}`
    }),
  )

  // --- CRM write actions ----------------------------------------------------

  const tagsOf = (raw: unknown): string[] =>
    String(raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

  app.post('/app/customers', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      const customer = await ctx.services.customers.create(actor, {
        name: String(body.name ?? ''),
        lifecycleStage: (body.lifecycleStage
          ? String(body.lifecycleStage)
          : 'lead') as CustomerLifecycleStage,
        tags: tagsOf(body.tags),
      })
      return `/app/customers/${customer.id}`
    }),
  )

  app.post('/app/customers/:id/contacts', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.contacts.add(actor, {
        customerId: id,
        name: String(body.name ?? ''),
        role: body.role ? String(body.role) : null,
        email: body.email ? String(body.email) : null,
        phone: body.phone ? String(body.phone) : null,
      })
      return `/app/customers/${id}`
    }),
  )

  app.post('/app/customers/:id/deals', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      const rawValue = String(body.value ?? '').trim()
      const value = rawValue === '' ? null : Number.parseInt(rawValue, 10)
      const currency = String(body.currency ?? '')
        .trim()
        .toUpperCase()
      await ctx.services.deals.create(actor, {
        customerId: id,
        title: String(body.title ?? ''),
        value: value != null && Number.isFinite(value) ? value : null,
        currency: currency === '' ? null : currency,
        tags: [],
      })
      return `/app/customers/${id}`
    }),
  )

  app.post('/app/deals/:id/stage', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      const deal = await ctx.services.deals.changeStage(actor, {
        dealId: c.req.param('id'),
        stage: String(body.stage) as DealPipelineStage,
      })
      // From the deal page, stay on it; from the customer kanban, return there.
      return body.returnTo === 'deal'
        ? `/app/deals/${deal.id}`
        : `/app/customers/${deal.customerId}`
    }),
  )

  app.post('/app/deals/:id/update', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      const intOrNull = (raw: unknown): number | null => {
        const s = String(raw ?? '').trim()
        if (s === '') return null
        const n = Number.parseInt(s, 10)
        return Number.isFinite(n) ? n : null
      }
      const currency = String(body.currency ?? '')
        .trim()
        .toUpperCase()
      await ctx.services.deals.update(actor, id, {
        title: String(body.title ?? ''),
        value: intOrNull(body.value),
        currency: currency === '' ? null : currency,
        closeDate: body.closeDate ? String(body.closeDate) : null,
        probability: intOrNull(body.probability),
        tags: tagsOf(body.tags),
      })
      return `/app/deals/${id}`
    }),
  )

  app.post('/app/deals/:id/link', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.deals.linkWork(actor, {
        dealId: id,
        projectId: String(body.projectId ?? ''),
      })
      return `/app/deals/${id}`
    }),
  )

  app.post('/app/customers/:id/interactions', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.interactions.log(actor, {
        targetType: 'customer',
        targetId: id,
        kind: String(body.kind ?? 'note') as InteractionKind,
        body: String(body.body ?? ''),
      })
      return `/app/customers/${id}`
    }),
  )

  app.post('/app/customers/:id/update', (c) =>
    action(c, async (actor) => {
      const id = c.req.param('id')
      const body = await c.req.parseBody()
      await ctx.services.customers.update(actor, id, {
        name: String(body.name ?? ''),
        tags: tagsOf(body.tags),
      })
      return `/app/customers/${id}`
    }),
  )

  // Contact edit/remove redirect back to the owning customer (passed as a hidden
  // field, since remove() returns only a flag).
  const contactReturn = (body: Record<string, unknown>) =>
    `/app/customers/${String(body.customerId ?? '')}`

  app.post('/app/contacts/:id/update', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      await ctx.services.contacts.update(actor, c.req.param('id'), {
        name: String(body.name ?? ''),
        role: body.role ? String(body.role) : null,
        email: body.email ? String(body.email) : null,
        phone: body.phone ? String(body.phone) : null,
      })
      return contactReturn(body)
    }),
  )

  app.post('/app/contacts/:id/remove', (c) =>
    action(c, async (actor) => {
      const body = await c.req.parseBody()
      await ctx.services.contacts.remove(actor, c.req.param('id'))
      return contactReturn(body)
    }),
  )
}
