import type { Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError, ForbiddenError } from '../errors.js'
import { parse } from '../validate.js'
import {
  type CreateOrgInput,
  type CreateTenantInput,
  createOrgInput,
  createTenantInput,
  type Org,
  type Principal,
  type Project,
  type Team,
  type User,
  z,
} from './deps.js'

/** Upper bound on workspaces a single account may own (anti-abuse guardrail). */
const MAX_WORKSPACES_PER_ACCOUNT = 25

/** Derive a valid org slug from a free-text workspace name (inlined to avoid an
 * import cycle with `onboarding.ts`). */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return base.length >= 2 ? base : 'workspace'
}

const founderInput = z.object({
  displayName: z.string().min(1).max(120),
  email: z.email(),
  name: z.string().min(1).max(120),
  avatarUrl: z.url().nullable().default(null),
  /** better-auth account id this founding user is anchored to (if known). */
  authUserId: z.string().min(1).nullable().default(null),
})
export type FounderInput = z.infer<typeof founderInput>

export interface BootstrapOrgInput {
  org: CreateOrgInput
  founder: FounderInput
}

export interface BootstrapResult {
  org: Org
  founder: Principal
  user: User
}

export interface CreateWorkspaceResult {
  org: Org
  founder: Principal
  team: Team
  project: Project
}

export interface OrgService {
  /**
   * Create a new org together with its founding human owner (principal + user +
   * an org-level `owner` membership). This is the unauthenticated entry point
   * used at signup; everything else requires an {@link Actor}.
   */
  bootstrap(input: BootstrapOrgInput): Promise<BootstrapResult>
  get(actor: Actor): Promise<Org>
  /**
   * Create an additional workspace for an already-onboarded account. Unlike
   * `bootstrap` (which mints a fresh user at signup), this reuses the caller's
   * global account: a new founder principal in the new org is linked to the
   * same `userId`, so the account belongs to both. Agents (single-org, no
   * userId) cannot create workspaces.
   */
  createWorkspace(actor: Actor, input: CreateTenantInput): Promise<CreateWorkspaceResult>
  /**
   * The workspaces (orgs) the calling principal's account belongs to — for an
   * agent acting on behalf of a multi-workspace human to discover and choose
   * which to act in (paired with the `X-Rooster-Org` request header).
   */
  listWorkspaces(actor: Actor): Promise<Workspace[]>
}

export interface Workspace {
  orgId: string
  slug: string
  name: string
  /** True for the workspace the caller is currently acting in. */
  current: boolean
}

export function createOrgService(repos: Repositories): OrgService {
  return {
    async bootstrap(input) {
      const org = parse(createOrgInput, input.org)
      const founder = parse(founderInput, input.founder)

      if (await repos.orgs.getBySlug(org.slug)) {
        throw new ConflictError(`Org slug '${org.slug}' is already taken`)
      }

      const created = await repos.orgs.create({
        slug: org.slug,
        name: org.name,
        enrollmentPolicy: org.enrollmentPolicy,
      })
      const principal = await repos.principals.create(created.id, {
        type: 'user',
        displayName: founder.displayName,
      })
      const user = await repos.users.create({
        principalId: principal.id,
        email: founder.email,
        name: founder.name,
        avatarUrl: founder.avatarUrl,
        authUserId: founder.authUserId,
      })
      // Back-link the principal to its global account so cross-workspace
      // lookups (a user's other orgs) resolve through `principals.userId`.
      await repos.principals.linkUser(created.id, principal.id, user.id)
      await repos.memberships.upsert(created.id, {
        principalId: principal.id,
        teamId: null,
        role: 'owner',
      })

      await recordAudit(
        repos,
        {
          orgId: created.id,
          principalId: principal.id,
          type: 'user',
          role: 'owner',
          scopes: [],
          clientInfo: null,
        },
        { action: 'org.bootstrap', targetType: 'org', targetId: created.id, after: created },
      )

      return { org: created, founder: principal, user }
    },

    async get(actor) {
      const org = await repos.orgs.getById(actor.orgId)
      if (!org) throw new ConflictError('Actor org no longer exists')
      return org
    },

    async createWorkspace(actor, rawInput) {
      const input = parse(createTenantInput, rawInput)

      // Only a human account (a user principal linked to a global account) may
      // create workspaces; agents are bound to their single org.
      const principal = await repos.principals.findById(actor.principalId)
      if (principal?.type !== 'user' || !principal.userId) {
        throw new ForbiddenError('Only a human account can create a workspace')
      }
      const userId = principal.userId

      // Guardrail: cap workspaces per account.
      const mine = await repos.principals.listByUserId(userId)
      if (new Set(mine.map((p) => p.orgId)).size >= MAX_WORKSPACES_PER_ACCOUNT) {
        throw new ConflictError(`Account is at the workspace limit (${MAX_WORKSPACES_PER_ACCOUNT})`)
      }

      // Allocate a unique slug from the workspace name (de-dupe on collision).
      const baseSlug = input.workspace.slug ?? slugify(input.workspace.name)
      let org: Org | null = null
      for (let attempt = 0; attempt <= 25 && !org; attempt++) {
        const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`
        if (await repos.orgs.getBySlug(slug)) continue
        org = await repos.orgs.create({
          slug,
          name: input.workspace.name,
          enrollmentPolicy: 'open',
        })
      }
      if (!org) {
        throw new ConflictError(`Could not find an available workspace slug near '${baseSlug}'`)
      }

      // New founder principal in the new org, linked to the SAME account.
      const founder = await repos.principals.create(org.id, {
        type: 'user',
        displayName: principal.displayName,
        userId,
      })
      await repos.memberships.upsert(org.id, {
        principalId: founder.id,
        teamId: null,
        role: 'owner',
      })

      // A first team + project so tickets can be filed immediately.
      const team = await repos.teams.create(org.id, { key: null, name: input.workspace.name })
      const project = await repos.projects.create(org.id, {
        teamId: team.id,
        key: input.project.key,
        name: input.project.name,
        description: null,
        archived: false,
      })

      await recordAudit(
        repos,
        { orgId: org.id, principalId: founder.id, type: 'user', role: 'owner', scopes: [] },
        {
          action: 'org.create_workspace',
          targetType: 'org',
          targetId: org.id,
          after: { slug: org.slug, projectKey: project.key },
        },
      )
      return { org, founder, team, project }
    },

    async listWorkspaces(actor) {
      const principal = await repos.principals.findById(actor.principalId)
      const userId = principal?.userId ?? null
      // Agents are bound to one org; humans may have a principal per org.
      const principals = userId
        ? await repos.principals.listByUserId(userId)
        : principal
          ? [principal]
          : []
      const orgIds = [...new Set(principals.map((p) => p.orgId))]
      const orgs = await Promise.all(orgIds.map((id) => repos.orgs.getById(id)))
      return orgs
        .filter((o): o is Org => o !== null)
        .map((o) => ({ orgId: o.id, slug: o.slug, name: o.name, current: o.id === actor.orgId }))
    },
  }
}
