import { provisionTenantForAccount } from '@rooster/core'
import type { ServerContext } from './context.js'

/**
 * First-run admin bootstrap for self-hosting. When `ROOSTER_ADMIN_EMAIL` +
 * `ROOSTER_ADMIN_PASSWORD` are configured and that email has no Rooster user
 * yet, create the better-auth account and a starter workspace so a solo or
 * internal-team operator can clone, set two env vars, start, and log in — no
 * email delivery, no sign-up form, no MCP dance.
 *
 * Idempotent: keyed on the domain user existing, so it runs once and is a no-op
 * on every subsequent boot. Best-effort — failures are logged, never fatal, so
 * a misconfig can't wedge startup.
 */
export async function bootstrapAdmin(ctx: ServerContext): Promise<void> {
  const admin = ctx.config.admin
  if (!admin) return

  // Already bootstrapped (or the email was onboarded another way) → no-op.
  if (await ctx.db.repositories.users.getByEmail(admin.email)) return

  try {
    const name = admin.email.split('@')[0] || 'Admin'
    const signUp = await ctx.auth.api.signUpEmail({
      body: { email: admin.email, password: admin.password, name },
    })
    const result = await provisionTenantForAccount(
      ctx.services,
      { authUserId: signUp.user.id, email: admin.email, name },
      { workspace: { name: admin.workspace }, project: { name: 'General', key: admin.projectKey } },
    )
    console.log(
      `🐓 Bootstrapped admin ${admin.email} → workspace "${result.org.name}" (/${result.org.slug}); project ${result.project.name} [${admin.projectKey}-…]`,
    )
  } catch (err) {
    console.error(
      `Failed to bootstrap admin ${admin.email} (continuing without it):`,
      err instanceof Error ? err.message : err,
    )
  }
}
