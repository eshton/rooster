import type { ZodType } from 'zod'
import { ValidationError } from './errors.js'

/**
 * Re-validate input at the core boundary (defense in depth — transports also
 * validate). Throws {@link ValidationError} carrying the zod issues as details.
 */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new ValidationError('Invalid input', result.error.issues)
  }
  return result.data
}
