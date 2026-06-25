import { CoreError } from '@rooster/core'

/** A successful tool result: the payload rendered as pretty JSON text. */
export function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/** An error tool result (isError) carrying a human-readable message. */
export function errorResult(message: string, code?: string) {
  return {
    content: [{ type: 'text' as const, text: code ? `[${code}] ${message}` : message }],
    isError: true as const,
  }
}

/**
 * Run a tool body, returning its value as a JSON result. Expected domain
 * failures ({@link CoreError}) become clean `isError` results with the code;
 * anything unexpected propagates (the SDK turns it into a generic error).
 */
export async function runTool(fn: () => Promise<unknown>) {
  try {
    return jsonResult(await fn())
  } catch (err) {
    if (err instanceof CoreError) return errorResult(err.message, err.code)
    throw err
  }
}
