import type { CrowNotifier } from '@rooster/core'

/**
 * Best-effort outbound webhook for notifications — crow (wake the assignee) plus
 * ticket activity (status / assignee / comment) delivered to watchers. Returns
 * `undefined` when no URL is configured (notifications stay audit-only).
 *
 * Kept in its own module — free of any Node-only imports (e.g. `pg`) — so the
 * Cloudflare Workers entry (`worker.ts`) can use it without pulling the Postgres
 * driver into the edge bundle.
 */
export function webhookCrowNotifier(url?: string): CrowNotifier | undefined {
  if (!url) return undefined
  return {
    async notify(event) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: event.kind, ...event }),
      })
    },
  }
}
