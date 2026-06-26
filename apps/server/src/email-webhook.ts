import type { EmailSender } from '@rooster/auth'

/**
 * Best-effort outbound webhook for transactional email (password reset).
 * Returns `undefined` when no URL is configured, so {@link createAuth} falls
 * back to its console-logging sender (fine for dev/self-host).
 *
 * Kept in its own module — free of any Node-only imports (e.g. `pg`) — so the
 * Cloudflare Workers entry (`worker.ts`) can use it without pulling the Postgres
 * driver into the edge bundle.
 */
export function webhookEmailSender(url?: string): EmailSender | undefined {
  if (!url) return undefined
  return {
    async send(message) {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'email', ...message }),
      })
    },
  }
}
