import { sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

/** Name of the libSQL native ANN index on `embeddings.embedding`. */
export const VECTOR_INDEX_NAME = 'embeddings_vec_idx'

/**
 * Idempotently create the polymorphic `embeddings` store (libSQL-native
 * vectors). The table is NOT a Drizzle migration because its
 * `embedding F32_BLOB(<dims>)` column is sized from `ROOSTER_EMBEDDING_DIMS` at
 * runtime — a static committed migration can't carry a configurable dimension.
 * Likewise the `libsql_vector_idx(...)` functional ANN index can't be expressed
 * by drizzle-kit without breaking the migration-drift check. So both live here,
 * created at connect/migrate time on the libSQL path.
 *
 * Best-effort: if the build predates native vectors (no `F32_BLOB` /
 * `libsql_vector_idx`), failures are swallowed and semantic search simply stays
 * unavailable. The `IF NOT EXISTS` guards make it safe to run on every connect —
 * so it runs on BOTH the Node/`db:migrate` path and the Cloudflare Worker cold
 * start, making the app's `ROOSTER_EMBEDDING_DIMS` the single source of truth for
 * the table size (ROO-41).
 *
 * Changing `dims` on an existing database has no effect here (the table already
 * exists) — `CREATE TABLE IF NOT EXISTS` won't resize it. Such a mismatch would
 * otherwise fail every insert silently, so it is detected and logged loudly here;
 * drop the `embeddings` table to recreate it at the new size, then re-embed via
 * `backfill_embeddings`.
 */
export async function ensureEmbeddingsStore(
  db: LibSQLDatabase<Record<string, never>>,
  dims: number,
): Promise<void> {
  const n = Math.max(1, Math.floor(dims))
  try {
    await db.run(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS embeddings (
          id text PRIMARY KEY NOT NULL,
          org_id text NOT NULL,
          source_type text NOT NULL,
          source_id text NOT NULL,
          chunk_index integer NOT NULL DEFAULT 0,
          char_start integer,
          char_end integer,
          model text NOT NULL,
          embedding F32_BLOB(${n}) NOT NULL,
          created_at text NOT NULL,
          updated_at text NOT NULL
        )`,
      ),
    )
    // Upgrade a pre-chunk table in place (ROO-36): add the chunk columns if
    // missing. Each ALTER is best-effort — "duplicate column name" on an
    // already-upgraded table is expected and ignored.
    for (const col of [
      'chunk_index integer NOT NULL DEFAULT 0',
      'char_start integer',
      'char_end integer',
    ]) {
      try {
        await db.run(sql.raw(`ALTER TABLE embeddings ADD COLUMN ${col}`))
      } catch {
        // column already exists — fine.
      }
    }
    // The uniqueness key gained `chunk_index`; drop the old single-row-per-source
    // index and create the chunk-aware one.
    await db.run(sql.raw('DROP INDEX IF EXISTS embeddings_source_uq'))
    await db.run(
      sql.raw(
        'CREATE UNIQUE INDEX IF NOT EXISTS embeddings_source_chunk_uq ON embeddings (org_id, source_type, source_id, chunk_index)',
      ),
    )
    await db.run(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS ${VECTOR_INDEX_NAME} ON embeddings (libsql_vector_idx(embedding))`,
      ),
    )

    // If the table already existed at a different vector width, the CREATE above
    // was a no-op (SQLite can't resize a column), so every insert will fail on a
    // dimension mismatch. Surface it loudly instead of silently — this is the
    // failure mode that made a misconfigured deploy look like it worked.
    try {
      const rows = (await db.all(
        sql.raw("SELECT sql FROM sqlite_master WHERE type='table' AND name='embeddings'"),
      )) as Array<{ sql: string | null }>
      const found = (rows[0]?.sql ?? '').match(/F32_BLOB\((\d+)\)/i)
      if (found && Number(found[1]) !== n) {
        console.error(
          `[embeddings] table is F32_BLOB(${found[1]}) but ROOSTER_EMBEDDING_DIMS=${n}. ` +
            'Every embedding insert will fail on a dimension mismatch. Drop the "embeddings" ' +
            'table so it recreates at the configured size, then run backfill_embeddings.',
        )
      }
    } catch {
      // schema probe is best-effort.
    }
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}
