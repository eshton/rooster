import { loadConfig } from '@rooster/config'
import { handle } from 'hono/vercel'
import { createApp } from './app.js'
import { createServerContext } from './context.js'

/**
 * Vercel Serverless Function handler. Runs on the **Node** runtime (the default
 * for `/api` functions) because the Postgres path uses a `pg.Pool`. The Hono app
 * is Web-standard `fetch`, so the adapter is a thin wrapper; the server context
 * (db + auth + services) is built once per warm instance and reused.
 *
 * The deployable entry is `apps/server/api/index.ts`, which re-exports this
 * after `pnpm build` produces `dist/vercel.js`. See docs/SELF_HOSTING.md.
 */
let handler: ((req: Request) => Response | Promise<Response>) | undefined

async function getHandler() {
  if (!handler) {
    const ctx = await createServerContext(loadConfig(), { migrate: true })
    handler = handle(createApp(ctx))
  }
  return handler
}

export default async function vercelHandler(req: Request): Promise<Response> {
  return (await getHandler())(req)
}
