import type { Repositories } from '@rooster/db'
import type { Actor } from '../actor.js'
import { recordAudit } from '../audit.js'
import { ConflictError } from '../errors.js'
import { parse } from '../validate.js'
import {
  type CreateOrgInput,
  createOrgInput,
  type Org,
  type Principal,
  type User,
  z,
} from './deps.js'

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

export interface OrgService {
  /**
   * Create a new org together with its founding human owner (principal + user +
   * an org-level `owner` membership). This is the unauthenticated entry point
   * used at signup; everything else requires an {@link Actor}.
   */
  bootstrap(input: BootstrapOrgInput): Promise<BootstrapResult>
  get(actor: Actor): Promise<Org>
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
