import type { Repositories } from '@rooster/db'
import { type Actor, type ActorIdentity, resolveActor } from '../actor.js'
import type { ServiceDeps } from '../notify.js'
import { type AgentService, createAgentService } from './agents.js'
import { type AttachmentService, createAttachmentService } from './attachments.js'
import { type AuditLogService, createAuditLogService } from './auditlog.js'
import { type CommentService, createCommentService } from './comments.js'
import { createInviteService, type InviteService } from './invites.js'
import { createMemberService, type MemberService } from './members.js'
import { createOrgService, type OrgService } from './orgs.js'
import { createProjectService, type ProjectService } from './projects.js'
import { createTeamService, type TeamService } from './teams.js'
import { createTicketService, type TicketService } from './tickets.js'
import { createWatcherService, type WatcherService } from './watchers.js'

export interface Services {
  orgs: OrgService
  teams: TeamService
  projects: ProjectService
  tickets: TicketService
  comments: CommentService
  attachments: AttachmentService
  watchers: WatcherService
  agents: AgentService
  members: MemberService
  invites: InviteService
  audit: AuditLogService
  /** Resolve a trusted identity into an {@link Actor} (role + scopes). */
  resolveActor(identity: ActorIdentity): Promise<Actor>
}

/**
 * Assemble the transport-agnostic domain service layer over a set of
 * repositories. This is the single entry point consumed by the MCP server and
 * the dashboard — neither talks to repositories directly.
 */
export function createServices(repos: Repositories, deps: ServiceDeps = {}): Services {
  return {
    orgs: createOrgService(repos),
    teams: createTeamService(repos),
    projects: createProjectService(repos),
    tickets: createTicketService(repos, deps.crowNotifier),
    comments: createCommentService(repos, deps.crowNotifier),
    attachments: createAttachmentService(repos),
    watchers: createWatcherService(repos),
    agents: createAgentService(repos),
    members: createMemberService(repos),
    invites: createInviteService(repos),
    audit: createAuditLogService(repos),
    resolveActor: (identity) => resolveActor(repos, identity),
  }
}

export type {
  AgentService,
  AttachmentService,
  AuditLogService,
  CommentService,
  InviteService,
  MemberService,
  OrgService,
  ProjectService,
  TeamService,
  TicketService,
  WatcherService,
}
