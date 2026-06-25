// Assemble the Cloudflare Pages bundle for the Rooster static sites.
//   dist-web/        ← marketing site (apps/marketing, base "/")
//   dist-web/docs/   ← documentation site (apps/docs, base "/docs")
// Run the per-app `astro build` steps first (see the `build:web` script).
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'

const OUT = 'dist-web'
const marketing = 'apps/marketing/dist'
const docs = 'apps/docs/dist'

for (const dir of [marketing, docs]) {
  if (!existsSync(dir)) {
    console.error(`Missing build output: ${dir}. Run the site builds first.`)
    process.exit(1)
  }
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
cpSync(marketing, OUT, { recursive: true })
cpSync(docs, `${OUT}/docs`, { recursive: true })

console.log(`Assembled ${OUT}/ (marketing at /, docs at /docs)`)
