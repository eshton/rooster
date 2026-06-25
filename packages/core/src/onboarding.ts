import type {
  Agent,
  AgentKind,
  EnrollmentPolicy,
  Org,
  Principal,
  Project,
  Team,
} from '@rooster/schema'
import type { Services } from './services/index.js'

/**
 * What to provision for a new tenant. The signup-token gate is a transport
 * policy (checked before this runs), so it is intentionally absent here.
 */
export interface ProvisionTenantSpec {
  org: { slug: string; name: string; enrollmentPolicy?: EnrollmentPolicy }
  founder: { name: string; email: string }
  team: { key: string; name: string }
  project: { name: string; description?: string }
  /** Optional first agent; if `oauthClientId` is set it is bound 1:1. */
  agent?: { displayName: string; kind?: AgentKind; scopes?: string[]; oauthClientId?: string }
}

export interface ProvisionTenantResult {
  org: Org
  founder: Principal
  team: Team
  project: Project
  agent: Agent | null
}

/**
 * Agent-first tenant bootstrap: create the org with its founding human owner,
 * then a team, a project and (optionally) a first agent that is granted `owner`
 * and bound to its OAuth client. Pure orchestration over the core services, so
 * every step still flows through permission checks and the audit log.
 */
export async function provisionTenant(
  services: Services,
  spec: ProvisionTenantSpec,
): Promise<ProvisionTenantResult> {
  const { org, founder } = await services.orgs.bootstrap({
    org: {
      slug: spec.org.slug,
      name: spec.org.name,
      enrollmentPolicy: spec.org.enrollmentPolicy ?? 'token',
    },
    founder: { displayName: spec.founder.name, ...spec.founder, avatarUrl: null },
  })

  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })

  const team = await services.teams.create(owner, { key: spec.team.key, name: spec.team.name })
  const project = await services.projects.create(owner, {
    teamId: team.id,
    name: spec.project.name,
    description: spec.project.description,
  })

  let agent: Agent | null = null
  if (spec.agent) {
    agent = await services.agents.register(owner, {
      displayName: spec.agent.displayName,
      kind: spec.agent.kind ?? 'custom',
      scopes: spec.agent.scopes ?? [],
    })
    // Make the first agent a co-owner so it can run the tenant autonomously.
    await services.members.upsert(owner, {
      principalId: agent.principalId,
      teamId: null,
      role: 'owner',
    })
    if (spec.agent.oauthClientId) {
      agent = await services.agents.bindOAuthClient(owner, agent.id, spec.agent.oauthClientId)
    }
  }

  return { org, founder, team, project, agent }
}
