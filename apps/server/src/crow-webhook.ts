import type { CrowNotifier } from '@rooster/core'

/**
 * Best-effort outbound webhook for `crow` notifications. Returns `undefined`
 * when no URL is configured (crow stays audit-only).
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
        body: JSON.stringify({ type: 'crow', ...event }),
      })
    },
  }
}
