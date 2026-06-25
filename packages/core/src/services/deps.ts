// Shared re-exports for the service layer: zod plus the schema DTOs/entities
// the services validate against, in one place to keep service imports compact.

export type {
  Agent,
  AgentStatus,
  AssignTicketInput,
  ChangeStatusInput,
  Comment,
  CommentInput,
  CreateOrgInput,
  CreateProjectInput,
  CreateTeamInput,
  CreateTicketInput,
  Id,
  InviteMemberInput,
  Membership,
  Org,
  Principal,
  Project,
  RegisterAgentInput,
  Role,
  Team,
  Ticket,
  TicketStatus,
  UpdateTicketInput,
  User,
} from '@rooster/schema'
export {
  assignTicketInput,
  changeStatusInput,
  commentInput,
  createOrgInput,
  createProjectInput,
  createTeamInput,
  createTicketInput,
  inviteMemberInput,
  registerAgentInput,
  updateTicketInput,
} from '@rooster/schema'
export { z } from 'zod'
