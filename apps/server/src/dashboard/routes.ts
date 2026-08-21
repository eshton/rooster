import { humanIdentityFromSessionEmail, listUserOrgs } from '@rooster/auth'
import { type Actor, CoreError } from '@rooster/core'
import type { TicketStatus } from '@rooster/schema'
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
  // Local single-user mode: no login — act as the bootstrapped local owner.
  // (Config permits this only on a localhost base URL.)
  if (ctx.config.localMode) {
    const email = ctx.config.admin?.email
    const identity = email ? await humanIdentityFromSessionEmail(ctx.db.repositories, email) : null
    if (!identity) return { noOrg: email ?? 'local owner' }
    return { actor: await ctx.services.resolveActor(identity) }
  }

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
      })
    }),
  )

  app.get('/app/deals/:id', (c) =>
    page(c, async (actor) => {
      const id = c.req.param('id')
      const deal = await ctx.services.deals.get(actor, id)
      const [customer, work] = await Promise.all([
        ctx.services.customers.get(actor, deal.customerId),
        ctx.services.deals.listWork(actor, { dealId: id }),
      ])
      return v.dealDetail({
        actor,
        deal,
        customer,
        work,
        label: crm.label,
      })
    }),
  )

  // No write routes: the dashboard is read-only (agents-first). All mutations
  // happen over MCP, where they are scope-gated, rate-limited and audited.
}
