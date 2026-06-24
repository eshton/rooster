import { z } from 'zod'

/**
 * All entity identifiers are UUIDs. We keep a single id schema so the shape is
 * uniform across the domain; branding is intentionally avoided to keep DTOs
 * trivially serializable across the MCP / HTTP boundary.
 */
export const idSchema = z.uuid()
export type Id = z.infer<typeof idSchema>

/** A short, human-facing ticket key, e.g. "ROOST-42". */
export const ticketKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}-\d+$/, 'Expected a ticket key like "ROOST-42"')
export type TicketKey = z.infer<typeof ticketKeySchema>

/** ISO-8601 timestamp string. */
export const timestampSchema = z.iso.datetime()
export type Timestamp = z.infer<typeof timestampSchema>
