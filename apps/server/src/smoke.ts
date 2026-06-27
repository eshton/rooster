import { loadConfig } from '@rooster/config'
import { createServices } from '@rooster/core'
import { createDatabase } from '@rooster/db'

/**
 * Core-flow smoke against the live `DATABASE_URL` — meant for the CI Postgres
 * job, which is the only place the **non-SQLite** dialect of the repository SQL
 * runs (the unit suite is in-memory SQLite). It deliberately exercises the
 * dialect-sensitive statements: per-project numbering, the self-healing
 * `nextNumber` correlated subquery, ranked `search` (LIKE), `set_project_key`'s
 * bulk re-key, watcher inserts, and a status transition. Exits non-zero on any
 * mismatch so CI fails loudly.
 *
 *   DATABASE_URL=postgres://… node apps/server/dist/smoke.js
 */
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`smoke failed: ${msg}`)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const stamp = Date.now()
  const db = await createDatabase(config, { migrate: true })
  const services = createServices(db.repositories)
  try {
    const { org, founder } = await services.orgs.bootstrap({
      org: { slug: `smoke-${stamp}`, name: 'Smoke', enrollmentPolicy: 'open' },
      founder: {
        displayName: 'Smoke',
        name: 'Smoke',
        email: `smoke-${stamp}@smoke.local`,
        avatarUrl: null,
        authUserId: null,
      },
    })
    const owner = await services.resolveActor({ orgId: org.id, principalId: founder.id })

    const team = await services.teams.create(owner, { name: 'Eng' })
    const project = await services.projects.create(owner, {
      teamId: team.id,
      key: 'SMK',
      name: 'Smoke',
    })

    // Per-project numbering + self-healing nextNumber (correlated subquery).
    const t1 = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'alpha',
      priority: 'none',
      labels: [],
    })
    const t2 = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'beta deadline',
      priority: 'none',
      labels: [],
    })
    assert(t1.key === 'SMK-1' && t2.key === 'SMK-2', 'per-project numbering')

    // Ranked search (LIKE + in-memory ranking) on the real dialect.
    const hits = await services.tickets.search(owner, 'deadline')
    assert(
      hits.some((t) => t.id === t2.id),
      'search finds the matching ticket',
    )

    // Watcher insert + status transition.
    await services.watchers.watch(owner, { ticketId: t1.id })
    const moved = await services.tickets.changeStatus(owner, {
      ticketId: t1.id,
      status: 'in_progress',
    })
    assert(moved.status === 'in_progress', 'status transition')

    // set_project_key: bulk re-key (substr/concat) — numbers preserved.
    await services.projects.setKey(owner, { projectId: project.id, key: 'SMX' })
    const reKeyed = await services.tickets.get(owner, t1.id)
    assert(reKeyed.key === 'SMX-1', 're-key in lockstep')

    // Next ticket continues the sequence under the new prefix (self-heal).
    const t3 = await services.tickets.create(owner, {
      projectId: project.id,
      title: 'gamma',
      priority: 'none',
      labels: [],
    })
    assert(t3.key === 'SMX-3', 'sequence continues past existing max')

    console.log('✓ Postgres core-flow smoke passed')
  } finally {
    await db.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
