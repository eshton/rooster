/**
 * Typed domain errors. Transports (MCP, HTTP) map `code` to a protocol-level
 * status; the core never throws bare `Error` for expected failure modes.
 */
export type CoreErrorCode = 'not_found' | 'forbidden' | 'validation' | 'conflict'

export class CoreError extends Error {
  readonly code: CoreErrorCode
  /** Optional machine-readable detail (e.g. zod issues) for transports. */
  readonly details?: unknown

  constructor(code: CoreErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.details = details
  }
}

/** A requested row does not exist (or is not visible in this tenant). */
export class NotFoundError extends CoreError {
  constructor(message: string) {
    super('not_found', message)
  }
}

/** The actor is authenticated but lacks the role or scope for the action. */
export class ForbiddenError extends CoreError {
  constructor(message: string) {
    super('forbidden', message)
  }
}

/** Input failed validation, or a domain invariant (e.g. status transition). */
export class ValidationError extends CoreError {
  constructor(message: string, details?: unknown) {
    super('validation', message, details)
  }
}

/** The action conflicts with current state (e.g. duplicate slug/key). */
export class ConflictError extends CoreError {
  constructor(message: string) {
    super('conflict', message)
  }
}
