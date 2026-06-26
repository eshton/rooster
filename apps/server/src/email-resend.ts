import type { EmailSender } from '@rooster/auth'

/**
 * Transactional-email delivery via Resend's HTTP API (https://resend.com).
 * Returns `undefined` unless both the API key and a verified from-address are
 * configured, so callers can fall back to the webhook / console seam.
 *
 * A single `fetch` with no Node-only imports, so it runs on the edge (Cloudflare
 * Workers) as well as Node. The sending domain must be verified in Resend for
 * mail to actually be delivered.
 */
export function resendEmailSender(apiKey?: string, from?: string): EmailSender | undefined {
  if (!apiKey || !from) return undefined
  return {
    async send({ to, subject, text }) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ from, to, subject, text }),
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`Resend email failed (${res.status}): ${detail.slice(0, 300)}`)
      }
    },
  }
}
