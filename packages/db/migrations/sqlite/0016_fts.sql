-- Portable full-text search (ROO-12), SQLite/libSQL side: an FTS5 index over
-- ticket title + description, kept in sync with the tickets table by triggers.
-- The FTS rows are linked to tickets by rowid (tickets has an implicit integer
-- rowid); the search query joins back on rowid and filters org_id on tickets.
-- The `porter` tokenizer gives stemming ("running" matches "run").
CREATE VIRTUAL TABLE tickets_fts USING fts5(title, description, tokenize = 'porter unicode61');
--> statement-breakpoint
INSERT INTO tickets_fts(rowid, title, description)
  SELECT rowid, title, coalesce(description, '') FROM tickets;
--> statement-breakpoint
CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  INSERT INTO tickets_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;
--> statement-breakpoint
CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER tickets_fts_au AFTER UPDATE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE rowid = old.rowid;
  INSERT INTO tickets_fts(rowid, title, description)
  VALUES (new.rowid, new.title, coalesce(new.description, ''));
END;
