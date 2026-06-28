import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Alias workspace packages to their TypeScript sources so tests run without a
// prior build step. The published `exports` still resolve to `dist/` at runtime.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@rooster/schema': r('./packages/schema/src/index.ts'),
      '@rooster/config': r('./packages/config/src/index.ts'),
      '@rooster/db': r('./packages/db/src/index.ts'),
      '@rooster/core': r('./packages/core/src/index.ts'),
      '@rooster/auth': r('./packages/auth/src/index.ts'),
      '@rooster/mcp': r('./packages/mcp/src/index.ts'),
    },
  },
  test: {
    include: ['{packages,apps}/**/*.{test,spec}.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Only measure the TypeScript sources we unit-test here. The Astro sites
      // (apps/docs, apps/marketing) and `*.test.ts` files are not in scope.
      include: ['packages/*/src/**/*.ts', 'apps/server/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts', // barrel re-exports
        // Thin deploy entrypoints / drivers — built production-shaped, first
        // exercised on a real deploy (no Postgres/Vercel/Workers in CI yet).
        'apps/server/src/node.ts',
        'apps/server/src/vercel.ts',
        'apps/server/src/worker.ts',
        'apps/server/src/smoke.ts',
        'apps/server/src/auth-schema.ts',
        'packages/db/src/migrate.ts',
        'packages/db/src/drivers/postgres.ts',
        'packages/db/src/drivers/libsql-web.ts',
      ],
      // Ratchet: a floor the current suite clears. Raise as coverage grows;
      // never lower it — a drop below these means new code arrived untested.
      thresholds: {
        statements: 85,
        branches: 69,
        functions: 80,
        lines: 87,
      },
    },
  },
})
