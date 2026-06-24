/**
 * Database driver kinds Rooster can talk to. The concrete driver is chosen
 * purely from the DATABASE_URL scheme — no code change to switch engines.
 */
export const DB_KINDS = ['postgres', 'sqlite', 'libsql'] as const
export type DbKind = (typeof DB_KINDS)[number]

/**
 * Resolve the driver kind from a connection string scheme:
 *   postgres:// | postgresql://  -> postgres
 *   file:                        -> sqlite (local file)
 *   libsql:// | https://         -> libsql (Turso / remote)
 *
 * Throws on an unrecognized scheme so misconfiguration fails fast at startup.
 */
export function resolveDbKind(databaseUrl: string): DbKind {
  const scheme = databaseUrl.split(':', 1)[0]?.toLowerCase()
  switch (scheme) {
    case 'postgres':
    case 'postgresql':
      return 'postgres'
    case 'file':
      return 'sqlite'
    case 'libsql':
    case 'https':
      return 'libsql'
    default:
      throw new Error(
        `Unsupported DATABASE_URL scheme "${scheme ?? ''}". ` +
          'Expected one of: postgres://, postgresql://, file:, libsql://, https://',
      )
  }
}
