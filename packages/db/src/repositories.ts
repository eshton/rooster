import type {
  Agent,
  AuditLog,
  Comment,
  Id,
  Membership,
  Org,
  Principal,
  Project,
  Team,
  Ticket,
} from '@rooster/schema'

/**
 * Repository contracts consumed by `@rooster/core`. Every method that touches a
 * tenant-scoped row REQUIRES an `orgId` as its first argument — row-level tenant
 * isolation is enforced here (defense in depth), not only at the transport.
 *
 * Concrete Drizzle-backed implementations land in phase 2. Defining the
 * contract now lets the core service layer be authored and tested against it.
 */

export interface ListOptions {
  limit?: number
  cursor?: string
}

export interface OrgRepository {
  create(input: Omit<Org, keyof TimestampedId>): Promise<Org>
  getById(id: Id): Promise<Org | null>
  getBySlug(slug: string): Promise<Org | null>
}

export interface TeamRepository {
  create(orgId: Id, input: Omit<Team, keyof TimestampedId | 'orgId'>): Promise<Team>
  getById(orgId: Id, id: Id): Promise<Team | null>
  list(orgId: Id, opts?: ListOptions): Promise<Team[]>
}

export interface ProjectRepository {
  create(orgId: Id, input: Omit<Project, keyof TimestampedId | 'orgId'>): Promise<Project>
  getById(orgId: Id, id: Id): Promise<Project | null>
  list(orgId: Id, teamId?: Id, opts?: ListOptions): Promise<Project[]>
}

export interface TicketRepository {
  create(orgId: Id, input: Omit<Ticket, keyof TimestampedId | 'orgId'>): Promise<Ticket>
  getById(orgId: Id, id: Id): Promise<Ticket | null>
  getByKey(orgId: Id, key: string): Promise<Ticket | null>
  list(orgId: Id, projectId: Id, opts?: ListOptions): Promise<Ticket[]>
  update(orgId: Id, id: Id, patch: Partial<Ticket>): Promise<Ticket>
  /** Allocate the next sequential ticket number for a team's key. */
  nextNumber(orgId: Id, teamId: Id): Promise<number>
}

export interface CommentRepository {
  create(orgId: Id, input: Omit<Comment, keyof TimestampedId | 'orgId'>): Promise<Comment>
  listForTicket(orgId: Id, ticketId: Id, opts?: ListOptions): Promise<Comment[]>
}

export interface PrincipalRepository {
  getById(orgId: Id, id: Id): Promise<Principal | null>
}

export interface AgentRepository {
  create(orgId: Id, input: Omit<Agent, keyof TimestampedId | 'orgId'>): Promise<Agent>
  getById(orgId: Id, id: Id): Promise<Agent | null>
  getByOAuthClientId(clientId: string): Promise<Agent | null>
  list(orgId: Id, opts?: ListOptions): Promise<Agent[]>
  update(orgId: Id, id: Id, patch: Partial<Agent>): Promise<Agent>
}

export interface MembershipRepository {
  list(orgId: Id, principalId: Id): Promise<Membership[]>
  upsert(orgId: Id, input: Omit<Membership, keyof TimestampedId | 'orgId'>): Promise<Membership>
}

export interface AuditLogRepository {
  /** Append-only: there is intentionally no update or delete. */
  append(orgId: Id, entry: Omit<AuditLog, 'id' | 'createdAt' | 'orgId'>): Promise<AuditLog>
  list(orgId: Id, opts?: ListOptions): Promise<AuditLog[]>
}

/** Convenience alias for the fields the persistence layer assigns. */
interface TimestampedId {
  id: Id
  createdAt: string
  updatedAt: string
}

export interface Repositories {
  orgs: OrgRepository
  teams: TeamRepository
  projects: ProjectRepository
  tickets: TicketRepository
  comments: CommentRepository
  principals: PrincipalRepository
  agents: AgentRepository
  memberships: MembershipRepository
  audit: AuditLogRepository
}
