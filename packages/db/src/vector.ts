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
 * unavailable. The `IF NOT EXISTS` guards make it safe to run on every connect.
 *
 * Changing `dims` on an existing database has no effect here (the table already
 * exists) — drop the `embeddings` table manually to resize, then re-embed via
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
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}
