import type {
  Agent,
  AgentKind,
  CreateTenantInput,
  EnrollmentPolicy,
  Org,
  Principal,
  Project,
  Team,
} from '@rooster/schema'
import { ConflictError } from './errors.js'
import type { Services } from './services/index.js'

/**
 * What to provision for a new tenant. The signup-token gate is a transport
 * policy (checked before this runs), so it is intentionally absent here.
 */
export interface ProvisionTenantSpec {
  org: { slug: string; name: string; enrollmentPolicy?: EnrollmentPolicy }
  founder: { name: string; email: string; authUserId?: string | null }
  team: { key?: string | null; name: string }
  project: { name: string; key: string; description?: string }
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
    founder: {
      displayName: spec.founder.name,
      name: spec.founder.name,
      email: spec.founder.email,
      authUserId: spec.founder.authUserId ?? null,
      avatarUrl: null,
    },
  })

  const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })

  const team = await services.teams.create(owner, {
    key: spec.team.key ?? undefined,
    name: spec.team.name,
  })
  const project = await services.projects.create(owner, {
    teamId: team.id,
    key: spec.project.key,
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

/** The verified account a {@link provisionTenantForAccount} call belongs to. */
export interface FounderAccount {
  /** Stable better-auth account id → the new user's `authUserId`. */
  authUserId: string
  email: string
  name: string
}

/** Derive a valid org slug from a free-text workspace name. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length >= 2 ? base : 'workspace'
}

/**
 * Self-service tenant bootstrap for an authenticated, orgless account (the
 * `create_tenant` MCP tool). Founder identity comes from the OAuth token, not
 * user input; the new owner user is anchored to `account.authUserId` so every
 * one of that human's OAuth clients later resolves to this same tenant. The org
 * slug is derived from the workspace name and de-duplicated on collision.
 */
export async function provisionTenantForAccount(
  services: Services,
  account: FounderAccount,
  input: CreateTenantInput,
): Promise<ProvisionTenantResult> {
  const baseSlug = input.workspace.slug ?? slugify(input.workspace.name)
  const founder = {
    name: account.name || account.email,
    email: account.email,
    authUserId: account.authUserId,
  }

  for (let attempt = 0; attempt <= 25; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`
    try {
      return await provisionTenant(services, {
        org: { slug, name: input.workspace.name, enrollmentPolicy: 'open' },
        founder,
        team: { name: input.workspace.name },
        project: { name: input.project.name, key: input.project.key },
      })
    } catch (err) {
      // Only a slug collision is retryable; surface anything else immediately.
      if (err instanceof ConflictError && err.message.includes('slug')) continue
      throw err
    }
  }
  throw new ConflictError(`Could not find an available workspace slug near '${baseSlug}'`)
}
