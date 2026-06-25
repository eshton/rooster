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
  },
})
