import { sql } from 'drizzle-orm'
import type { LibSQLDatabase } from 'drizzle-orm/libsql'

/** Name of the libSQL native ANN index on `embeddings.embedding`. */
export const VECTOR_INDEX_NAME = 'embeddings_vec_idx'

/**
 * Idempotently create the libSQL native vector (DiskANN) index on the
 * `embeddings` table. This is a FUNCTIONAL index (`libsql_vector_idx(...)`),
 * which drizzle-kit can't reproduce from the schema without breaking the
 * migration-drift check — so it lives here, created at connect/migrate time on
 * the libSQL path rather than in a generated migration.
 *
 * Best-effort: if the table isn't there yet (migrations pending) or the build
 * predates native vectors, it's swallowed and semantic search simply stays
 * unavailable until the next connect.
 */
export async function ensureVectorIndex(db: LibSQLDatabase<Record<string, never>>): Promise<void> {
  try {
    await db.run(
      sql.raw(
        `CREATE INDEX IF NOT EXISTS ${VECTOR_INDEX_NAME} ON embeddings (libsql_vector_idx(embedding))`,
      ),
    )
  } catch {
    // Intentionally ignored — see the doc comment.
  }
}
