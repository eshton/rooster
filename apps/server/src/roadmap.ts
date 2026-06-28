import type { Project, Ticket, TicketPriority } from '@rooster/schema'
import { TICKET_PRIORITIES } from '@rooster/schema'
import type { ServerContext } from './context.js'

/** The resolved public roadmap: the target project plus its tickets, sorted. */
export interface PublicRoadmap {
  org: { name: string; slug: string }
  project: Project
  /** Title to render (the configured override, or "<project> roadmap"). */
  title: string
  /** Tickets sorted by priority (highest first); canceled tickets dropped. */
  tickets: Ticket[]
}

/** Priority rank for sorting — higher is more urgent. */
const PRIORITY_RANK: Record<TicketPriority, number> = Object.fromEntries(
  TICKET_PRIORITIES.map((p, i) => [p, i]),
) as Record<TicketPriority, number>

/**
 * Load the configured public roadmap directly from the repositories. This is a
 * deliberate **unauthenticated** read: the operator opts a single project in via
 * `ROOSTER_ROADMAP_*` config, designating its tickets as public — so it bypasses
 * the per-actor authorize layer rather than resolving an actor. It is read-only
 * and scoped to exactly that one (org, project).
 *
 * Returns null when the roadmap is unconfigured or the configured workspace /
 * project can't be found, so the route can render a clean 404.
 */
export async function loadPublicRoadmap(ctx: ServerContext): Promise<PublicRoadmap | null> {
  const cfg = ctx.config.roadmap
  if (!cfg) return null

  const repos = ctx.db.repositories
  const org = await repos.orgs.getBySlug(cfg.orgSlug)
  if (!org) return null

  // No getByKey on projects; the project set per org is tiny, so list + match.
  const projects = await repos.projects.list(org.id)
  const project = projects.find((p) => p.key === cfg.projectKey)
  if (!project) return null

  const tickets = await repos.tickets.list(org.id, project.id, { limit: 500 })
  const sorted = tickets
    .filter((t) => t.status !== 'canceled')
    .sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.number - b.number)

  return {
    org: { name: org.name, slug: org.slug },
    project,
    title: cfg.title ?? `${project.name} roadmap`,
    tickets: sorted,
  }
}
