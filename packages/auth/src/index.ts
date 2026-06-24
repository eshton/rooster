export { drizzleAdapter } from 'better-auth/adapters/drizzle'
// Re-export the better-auth database adapters so consumers pick one without a
// direct better-auth dependency: memory for dev/tests, drizzle for production.
export { memoryAdapter } from 'better-auth/adapters/memory'
export * from './auth.js'
export * from './enrollment.js'
export * from './identity.js'
export * from './provisioning.js'
export * from './scopes.js'
