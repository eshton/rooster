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

/**
 * A project's ticket-key prefix, unique per org — the part before the number in
 * a ticket key (e.g. "ASA" → ASA-1, ASA-2). Prefer **3** characters; widen to 4
 * or 5 only when a shorter key is already taken in the org (collision). Each
 * project carries its own key and its own number sequence, so tickets read as
 * "<project key>-<n>" and numbering restarts per project.
 */
export const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{2,4}$/, 'Uppercase project key of 3–5 chars, e.g. "ASA"')
export type ProjectKey = z.infer<typeof projectKeySchema>

/** ISO-8601 timestamp string. */
export const timestampSchema = z.iso.datetime()
export type Timestamp = z.infer<typeof timestampSchema>
