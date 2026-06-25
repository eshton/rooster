import { timingSafeEqual } from 'node:crypto'

/**
 * Decide whether a tenant self-registration attempt is allowed.
 * - No token configured  → open registration (self-host default).
 * - Token configured     → the request must present a matching token
 *   (constant-time comparison).
 */
export function signupAllowed(
  configured: string | undefined,
  provided: string | undefined,
): boolean {
  if (!configured) return true
  if (!provided) return false
  const a = Buffer.from(configured)
  const b = Buffer.from(provided)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
