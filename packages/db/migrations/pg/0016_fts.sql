-- Portable full-text search (ROO-12), Postgres side: a GIN index over the
-- combined ticket title + description tsvector. The search query's WHERE clause
-- uses the SAME expression so the planner can use this index; ranking
-- (ts_rank, with title weighted above description) is computed in the ORDER BY.
CREATE INDEX IF NOT EXISTS tickets_fts_idx ON tickets
  USING gin (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, '')));
