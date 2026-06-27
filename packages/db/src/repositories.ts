import type {
  Agent,
  Attachment,
  AuditLog,
  Comment,
  Id,
  Invite,
  Membership,
  Milestone,
  Org,
  Principal,
  Project,
  Team,
  Ticket,
  TicketLink,
  User,
  Watcher,
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
  update(orgId: Id, id: Id, patch: Partial<Project>): Promise<Project>
}

export interface TicketRepository {
  create(orgId: Id, input: Omit<Ticket, keyof TimestampedId | 'orgId'>): Promise<Ticket>
  getById(orgId: Id, id: Id): Promise<Ticket | null>
  getByKey(orgId: Id, key: string): Promise<Ticket | null>
  list(
    orgId: Id,
    projectId: Id,
    opts?: ListOptions & { status?: string; assigneeId?: Id; milestoneId?: Id },
  ): Promise<Ticket[]>
  /** Tickets across the org assigned to a given principal. */
  listAssigned(orgId: Id, assigneeId: Id, opts?: ListOptions): Promise<Ticket[]>
  /** Tickets across the org carrying a given label/tag (exact match). */
  listByLabel(orgId: Id, label: string, opts?: ListOptions): Promise<Ticket[]>
  /** Full-text-ish search across title + description (case-insensitive). */
  search(orgId: Id, query: string, opts?: ListOptions): Promise<Ticket[]>
  /** Direct children (subtasks) of a parent ticket. */
  listChildren(orgId: Id, parentId: Id, opts?: ListOptions): Promise<Ticket[]>
  update(orgId: Id, id: Id, patch: Partial<Ticket>): Promise<Ticket>
  /**
   * Rewrite the key prefix of every ticket in a project (`<oldPrefix>-<n>` →
   * `<newPrefix>-<n>`), leaving numbers untouched. Returns the count updated.
   */
  reKeyForProject(orgId: Id, projectId: Id, oldPrefix: string, newPrefix: string): Promise<number>
  /** Allocate the next sequential ticket number for a project. */
  nextNumber(orgId: Id, projectId: Id): Promise<number>
}

export interface MilestoneRepository {
  create(orgId: Id, input: Omit<Milestone, keyof TimestampedId | 'orgId'>): Promise<Milestone>
  getById(orgId: Id, id: Id): Promise<Milestone | null>
  listForProject(orgId: Id, projectId: Id, opts?: ListOptions): Promise<Milestone[]>
}

export interface CommentRepository {
  create(orgId: Id, input: Omit<Comment, keyof TimestampedId | 'orgId'>): Promise<Comment>
  listForTicket(orgId: Id, ticketId: Id, opts?: ListOptions): Promise<Comment[]>
}

export interface AttachmentRepository {
  create(orgId: Id, input: Omit<Attachment, keyof TimestampedId | 'orgId'>): Promise<Attachment>
  listForTicket(orgId: Id, ticketId: Id, opts?: ListOptions): Promise<Attachment[]>
  getById(orgId: Id, id: Id): Promise<Attachment | null>
  /** Delete an attachment by id; true if a row was removed. */
  delete(orgId: Id, id: Id): Promise<boolean>
}

export interface WatcherRepository {
  /** Idempotently add a watcher; returns the (existing or new) row. */
  add(orgId: Id, ticketId: Id, principalId: Id): Promise<Watcher>
  /** Remove a watcher; true if a row was removed. */
  remove(orgId: Id, ticketId: Id, principalId: Id): Promise<boolean>
  /** Watchers of a ticket. */
  listForTicket(orgId: Id, ticketId: Id): Promise<Watcher[]>
  /** Tickets a principal watches (most-recent first). */
  listWatchedTicketIds(orgId: Id, principalId: Id, opts?: ListOptions): Promise<Id[]>
}

export interface TicketLinkRepository {
  create(orgId: Id, input: Omit<TicketLink, keyof TimestampedId | 'orgId'>): Promise<TicketLink>
  /** Every link where the ticket is either endpoint (outgoing or incoming). */
  listForTicket(orgId: Id, ticketId: Id): Promise<TicketLink[]>
  /** An existing link of `type` from one ticket to another, if any. */
  find(orgId: Id, fromTicketId: Id, toTicketId: Id, type: string): Promise<TicketLink | null>
  /** Remove a link by its from/to/type triple; true if a row was deleted. */
  delete(orgId: Id, fromTicketId: Id, toTicketId: Id, type: string): Promise<boolean>
}

export interface PrincipalRepository {
  create(
    orgId: Id,
    input: Omit<Principal, keyof TimestampedId | 'orgId' | 'userId'> & { userId?: Id | null },
  ): Promise<Principal>
  getById(orgId: Id, id: Id): Promise<Principal | null>
  /**
   * Look up a principal by id WITHOUT an org filter. For resolving a caller's
   * own principal (and thus their org) from a session; never use it to bypass
   * tenant scoping on tenant data.
   */
  findById(id: Id): Promise<Principal | null>
  /** All principals in an org (used to resolve names + list members). */
  listByOrg(orgId: Id, opts?: ListOptions): Promise<Principal[]>
  /**
   * Every principal belonging to a global user account, across all orgs. This
   * is the cross-workspace lookup: one account → one principal per org joined.
   */
  listByUserId(userId: Id): Promise<Principal[]>
  /** Back-link a user-type principal to its global account. */
  linkUser(orgId: Id, id: Id, userId: Id): Promise<Principal>
}

/**
 * Users are global identities (not org-scoped); a Principal links a user into a
 * specific org. The user repository is therefore the one place without an
 * `orgId` argument.
 */
export interface UserRepository {
  create(
    input: Omit<User, keyof TimestampedId | 'authUserId'> & { authUserId?: string | null },
  ): Promise<User>
  getById(id: Id): Promise<User | null>
  getByEmail(email: string): Promise<User | null>
  getByPrincipalId(principalId: Id): Promise<User | null>
  /** Resolve a Rooster user by the better-auth account id it is anchored to. */
  getByAuthUserId(authUserId: string): Promise<User | null>
  /** Lazily anchor an existing (email-created) user to its better-auth account. */
  linkAuthUserId(id: Id, authUserId: string): Promise<User>
}

export interface AgentRepository {
  create(orgId: Id, input: Omit<Agent, keyof TimestampedId | 'orgId'>): Promise<Agent>
  getById(orgId: Id, id: Id): Promise<Agent | null>
  getByOAuthClientId(clientId: string): Promise<Agent | null>
  list(orgId: Id, opts?: ListOptions): Promise<Agent[]>
  update(orgId: Id, id: Id, patch: Partial<Agent>): Promise<Agent>
}

export interface RateLimitHit {
  /** Request count within the current fixed window. */
  count: number
  /** ISO start of the current window. */
  windowStart: string
}

export interface RateLimitRepository {
  /**
   * Atomically record a hit for `key` in a fixed window, resetting the window
   * when the prior one has elapsed. A single upsert (no transaction), so it is
   * correct and shared across instances (edge/serverless).
   */
  hit(key: Id, nowIso: string, windowFloorIso: string): Promise<RateLimitHit>
}

export interface MembershipRepository {
  list(orgId: Id, principalId: Id): Promise<Membership[]>
  /** Every membership in an org (used to compute each member's role). */
  listByOrg(orgId: Id): Promise<Membership[]>
  upsert(orgId: Id, input: Omit<Membership, keyof TimestampedId | 'orgId'>): Promise<Membership>
}

export interface InviteRepository {
  create(orgId: Id, input: Omit<Invite, keyof TimestampedId | 'orgId' | 'uses'>): Promise<Invite>
  /** Look up a code WITHOUT an org filter (codes are globally unique). */
  getByCode(code: string): Promise<Invite | null>
  /** Atomically record one redemption. */
  incrementUses(orgId: Id, id: Id): Promise<Invite>
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
  ticketLinks: TicketLinkRepository
  watchers: WatcherRepository
  milestones: MilestoneRepository
  comments: CommentRepository
  attachments: AttachmentRepository
  principals: PrincipalRepository
  users: UserRepository
  agents: AgentRepository
  memberships: MembershipRepository
  invites: InviteRepository
  rateLimits: RateLimitRepository
  audit: AuditLogRepository
}
