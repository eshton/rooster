/** Deployment targets `apps/server` can run on from one codebase. */
export const PLATFORMS = ['node', 'vercel', 'cloudflare'] as const
export type Platform = (typeof PLATFORMS)[number]

/**
 * Best-effort detection of the deployment platform from well-known env vars,
 * overridable via ROOSTER_PLATFORM. Defaults to `node` for self-host/dev.
 */
export function detectPlatform(env: Record<string, string | undefined>): Platform {
  const override = env.ROOSTER_PLATFORM?.toLowerCase()
  if (override === 'node' || override === 'vercel' || override === 'cloudflare') {
    return override
  }
  if (env.VERCEL || env.VERCEL_ENV) return 'vercel'
  // Cloudflare Workers expose no process.env; presence of this hint is opt-in.
  if (env.CF_PAGES || env.CLOUDFLARE_WORKER) return 'cloudflare'
  return 'node'
}
