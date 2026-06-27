import { loadConfig } from '@rooster/config'
import { createDatabase } from './database.js'
import type { Repositories } from './repositories.js'

export interface SeedResult {
  orgId: string
  teamId: string
  projectId: string
  ownerUserId: string
  agentId: string
  ticketKeys: string[]
}

/**
 * Populate a database with a small, coherent demo dataset: one org with a team
 * and project, a human owner, a registered agent, a couple of tickets (one
 * assigned to the agent), a membership and an audit entry. Idempotent by org
 * slug — re-running returns the existing org untouched.
 */
export async function seed(repos: Repositories): Promise<SeedResult> {
  const existing = await repos.orgs.getBySlug('acme')
  if (existing) {
    const teams = await repos.teams.list(existing.id)
    const projects = await repos.projects.list(existing.id)
    const agents = await repos.agents.list(existing.id)
    const tickets = projects[0] ? await repos.tickets.list(existing.id, projects[0].id) : []
    return {
      orgId: existing.id,
      teamId: teams[0]?.id ?? '',
      projectId: projects[0]?.id ?? '',
      ownerUserId: '',
      agentId: agents[0]?.id ?? '',
      ticketKeys: tickets.map((t) => t.key),
    }
  }

  const org = await repos.orgs.create({
    slug: 'acme',
    name: 'Acme Coop',
    enrollmentPolicy: 'token',
  })

  const ownerPrincipal = await repos.principals.create(org.id, {
    type: 'user',
    displayName: 'Ada Lovelace',
  })
  const owner = await repos.users.create({
    principalId: ownerPrincipal.id,
    email: 'ada@acme.test',
    name: 'Ada Lovelace',
    avatarUrl: null,
  })
  await repos.memberships.upsert(org.id, {
    principalId: ownerPrincipal.id,
    teamId: null,
    role: 'owner',
  })

  const team = await repos.teams.create(org.id, { key: 'ROOST', name: 'Roost' })
  const project = await repos.projects.create(org.id, {
    teamId: team.id,
    key: 'HEN',
    name: 'Henhouse',
    description: 'The flagship coop.',
    archived: false,
  })

  const agentPrincipal = await repos.principals.create(org.id, {
    type: 'agent',
    displayName: 'Backend Claude #1',
  })
  const agent = await repos.agents.create(org.id, {
    principalId: agentPrincipal.id,
    ownerUserId: owner.id,
    displayName: 'Backend Claude #1',
    kind: 'claude-code',
    vendor: 'Anthropic',
    version: null,
    oauthClientId: null,
    scopes: [`org:${org.id}`, 'ticket:write'],
    status: 'active',
  })

  const ticketKeys: string[] = []
  for (const [i, spec] of [
    { title: 'Lay the foundation', assignee: null },
    { title: 'Wire up the roost', assignee: agentPrincipal.id },
  ].entries()) {
    const number = await repos.tickets.nextNumber(org.id, project.id)
    const ticket = await repos.tickets.create(org.id, {
      projectId: project.id,
      key: `${project.key}-${number}`,
      number,
      title: spec.title,
      description: null,
      status: i === 0 ? 'todo' : 'in_progress',
      priority: 'medium',
      labels: ['seed'],
      assigneeId: spec.assignee,
      parentId: null,
      dueDate: null,
      estimate: null,
    })
    ticketKeys.push(ticket.key)
  }

  await repos.audit.append(org.id, {
    principalId: agentPrincipal.id,
    action: 'seed.bootstrap',
    targetType: 'org',
    targetId: org.id,
    before: null,
    after: { tickets: ticketKeys },
    clientInfo: { name: 'rooster-seed', version: '0' },
  })

  return {
    orgId: org.id,
    teamId: team.id,
    projectId: project.id,
    ownerUserId: owner.id,
    agentId: agent.id,
    ticketKeys,
  }
}

// CLI entry: `pnpm --filter @rooster/db db:seed` (after `pnpm build`).
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig()
  const db = await createDatabase(config, { migrate: true })
  try {
    const result = await seed(db.repositories)
    console.log('Seeded Rooster:', JSON.stringify(result, null, 2))
  } finally {
    await db.close()
  }
}
