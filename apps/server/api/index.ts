// Vercel Serverless Function entry. The real (type-checked) handler lives in
// src/vercel.ts and is compiled to dist/vercel.js by `pnpm build`, which runs
// before Vercel bundles this shim. Kept out of the tsc project (see
// tsconfig "include") so it doesn't reference the build output at typecheck time.
export { default } from '../dist/vercel.js'
