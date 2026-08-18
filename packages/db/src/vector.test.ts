import { createClient } from '@libsql/client'
import { sql } from 'drizzle-orm'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureEmbeddingsStore } from './vector.js'

type AnyDb = LibSQLDatabase<Record<string, never>>

describe('ensureEmbeddingsStore', () => {
  afterEach(() => vi.restoreAllMocks())

  it('creates the embeddings table sized to the requested dimension', async () => {
    const client = createClient({ url: ':memory:' })
    const db = drizzle(client) as unknown as AnyDb
    await ensureEmbeddingsStore(db, 8)
    const rows = (await db.all(
      sql.raw("SELECT sql FROM sqlite_master WHERE name='embeddings'"),
    )) as Array<{ sql: string }>
    expect(rows[0]?.sql).toContain('F32_BLOB(8)')
    client.close()
  })

  it('logs loudly when an existing table dimension differs (no silent failure)', async () => {
    const client = createClient({ url: ':memory:' })
    const db = drizzle(client) as unknown as AnyDb
    await ensureEmbeddingsStore(db, 4) // table created at 4
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await ensureEmbeddingsStore(db, 8) // now ask for 8 → CREATE IF NOT EXISTS is a no-op

    expect(err).toHaveBeenCalledTimes(1)
    const msg = String(err.mock.calls[0]?.[0])
    expect(msg).toContain('F32_BLOB(4)')
    expect(msg).toContain('ROOSTER_EMBEDDING_DIMS=8')
    client.close()
  })
})
