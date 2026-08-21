// Durable better-auth tables on the Node/SQLite (libSQL) path (ROO-66).
//
// On Postgres, better-auth manages its own tables (via `auth:migrate`). On the
// Node/SQLite path it used the in-memory adapter, so logins reset on restart.
// Here we create better-auth's tables on the same libSQL connection and let it
// run through the drizzle adapter instead — sessions then persist.
//
// The DDL mirrors `auth-schema.ts` (the exact camelCase schema the Cloudflare
// Worker already runs durably on Turso, verified against `auth:migrate`). Keep
// the two in lockstep. Idempotent: every statement is CREATE TABLE IF NOT EXISTS.

const NOW_MS = "(cast(unixepoch('subsecond') * 1000 as integer))"

const AUTH_TABLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "email" text NOT NULL UNIQUE,
    "emailVerified" integer NOT NULL DEFAULT 0,
    "image" text,
    "createdAt" integer NOT NULL DEFAULT ${NOW_MS},
    "updatedAt" integer NOT NULL DEFAULT ${NOW_MS}
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    "id" text PRIMARY KEY NOT NULL,
    "expiresAt" integer NOT NULL,
    "token" text NOT NULL UNIQUE,
    "createdAt" integer NOT NULL,
    "updatedAt" integer NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
    "id" text PRIMARY KEY NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" integer,
    "refreshTokenExpiresAt" integer,
    "scope" text,
    "password" text,
    "createdAt" integer NOT NULL,
    "updatedAt" integer NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    "id" text PRIMARY KEY NOT NULL,
    "identifier" text NOT NULL,
    "value" text NOT NULL,
    "expiresAt" integer NOT NULL,
    "createdAt" integer NOT NULL DEFAULT ${NOW_MS},
    "updatedAt" integer NOT NULL DEFAULT ${NOW_MS}
  )`,
  `CREATE TABLE IF NOT EXISTS "oauthApplication" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text,
    "icon" text,
    "metadata" text,
    "clientId" text UNIQUE,
    "clientSecret" text,
    "redirectUrls" text,
    "type" text,
    "disabled" integer DEFAULT 0,
    "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
    "createdAt" integer,
    "updatedAt" integer
  )`,
  `CREATE TABLE IF NOT EXISTS "oauthAccessToken" (
    "id" text PRIMARY KEY NOT NULL,
    "accessToken" text UNIQUE,
    "refreshToken" text UNIQUE,
    "accessTokenExpiresAt" integer,
    "refreshTokenExpiresAt" integer,
    "clientId" text REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
    "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
    "scopes" text,
    "createdAt" integer,
    "updatedAt" integer
  )`,
  `CREATE TABLE IF NOT EXISTS "oauthConsent" (
    "id" text PRIMARY KEY NOT NULL,
    "clientId" text REFERENCES "oauthApplication"("clientId") ON DELETE CASCADE,
    "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
    "scopes" text,
    "createdAt" integer,
    "updatedAt" integer,
    "consentGiven" integer
  )`,
]

/**
 * Create better-auth's tables if absent, using a raw SQL runner bound to the
 * same libSQL connection the domain tables live on. Idempotent.
 */
export async function ensureAuthTables(execute: (sql: string) => Promise<void>): Promise<void> {
  for (const ddl of AUTH_TABLE_DDL) await execute(ddl)
}
