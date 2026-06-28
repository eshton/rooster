# Postgres migrations — FROZEN / community-maintained

SQLite / libSQL (Turso) is Rooster's single first-class, CI-tested dialect (it
powers the test suite, production on Turso, and semantic search via libSQL native
vectors). These Postgres migrations are **preserved so the `postgres` driver keeps
working for self-hosters who prefer it, but they are not regenerated or verified
in CI and may drift** from `src/schema/sqlite.ts`.

If you maintain the Postgres path: mirror your schema change into
`src/schema/pg.ts` and regenerate with

```bash
pnpm --filter @rooster/db db:generate:pg
```

CI only checks SQLite migration drift (`db:generate:sqlite`). Native-vector
columns (libSQL `F32_BLOB` + `libsql_vector_idx`) have no equivalent here.
