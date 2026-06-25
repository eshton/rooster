/**
 * Workers / edge entry point. Imports ONLY the HTTP libSQL driver, so bundling
 * this (e.g. into a Cloudflare Worker) never pulls in `pg` or the native libSQL
 * client. Use `@rooster/db` (the main entry) on Node; use `@rooster/db/web`
 * on Workers.
 */

export type { Database } from './database.js'
export { createLibsqlWebDatabase, createLibsqlWebDrizzle } from './drivers/libsql-web.js'
export { createRepositories } from './repositories/impl.js'
export type * from './repositories.js'
export { sqliteSchema } from './schema/sqlite.js'
