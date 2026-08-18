import { CoreError } from './errors.js'

/** Default attempts *after* the first try, and the base backoff in ms. */
const DEFAULT_RETRIES = 2
const DEFAULT_BASE_MS = 20

export interface RetryOptions {
  /** Extra attempts after the first (so total tries = retries + 1). */
  retries?: number
  /** Backoff base; delay before attempt N is `baseMs * 2 ** (N-1)`. */
  baseMs?: number
  /** Injectable sleep so tests run without real timers. */
  sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Retry a DB/infrastructure operation on transient failure with exponential
 * backoff. Only *unexpected* errors are retried: a {@link CoreError} is an
 * expected domain outcome (not_found, validation, …) and is rethrown at once,
 * so a genuinely missing project or invalid input never triggers a retry loop.
 * Used to paper over the transient libSQL/Turso connection blips that were
 * leaving `create_tickets` batches partially applied (ROO-33).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS
  const sleep = opts.sleep ?? realSleep

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof CoreError) throw err
      lastErr = err
      if (attempt < retries) await sleep(baseMs * 2 ** attempt)
    }
  }
  throw lastErr
}
