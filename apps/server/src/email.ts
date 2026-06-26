import type { EmailSender } from '@rooster/auth'
import type { RoosterConfig } from '@rooster/config'
import { resendEmailSender } from './email-resend.js'
import { webhookEmailSender } from './email-webhook.js'

/**
 * Pick how transactional email is delivered, in priority order: Resend (the
 * edge-friendly hosted default) → an outbound webhook → `undefined`, which lets
 * {@link createAuth} fall back to its console logger (dev/self-host). Pure
 * config selection, free of Node-only imports so the Worker entry can use it.
 */
export function emailSenderFor(config: RoosterConfig): EmailSender | undefined {
  const n = config.notifications
  return (
    resendEmailSender(n.emailResendApiKey, n.emailFrom) ?? webhookEmailSender(n.emailWebhookUrl)
  )
}
