// better-auth's table schema (libSQL/sqlite) for the Cloudflare Workers runtime,
// where auth uses better-auth's drizzle adapter. The node/Postgres paths use
// better-auth's built-in adapter and don't need this.
//
// IMPORTANT: table + column names are camelCase to match exactly what
// better-auth's CLI migrate (`auth:migrate`) creates — verified against a real
// migrated database. Do not "snake_case" these; the drizzle adapter queries
// these literal names.
import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).default(false).notNull(),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).default(nowMs).notNull(),
})

export const oauthApplication = sqliteTable('oauthApplication', {
  id: text('id').primaryKey(),
  name: text('name'),
  icon: text('icon'),
  metadata: text('metadata'),
  clientId: text('clientId').unique(),
  clientSecret: text('clientSecret'),
  redirectUrls: text('redirectUrls'),
  type: text('type'),
  disabled: integer('disabled', { mode: 'boolean' }).default(false),
  userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }),
})

export const oauthAccessToken = sqliteTable('oauthAccessToken', {
  id: text('id').primaryKey(),
  accessToken: text('accessToken').unique(),
  refreshToken: text('refreshToken').unique(),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp_ms' }),
  clientId: text('clientId').references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
  userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
  scopes: text('scopes'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }),
})

export const oauthConsent = sqliteTable('oauthConsent', {
  id: text('id').primaryKey(),
  clientId: text('clientId').references(() => oauthApplication.clientId, { onDelete: 'cascade' }),
  userId: text('userId').references(() => user.id, { onDelete: 'cascade' }),
  scopes: text('scopes'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }),
  consentGiven: integer('consentGiven', { mode: 'boolean' }),
})
