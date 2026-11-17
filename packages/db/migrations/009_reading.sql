CREATE TABLE reading_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK(format IN ('epub','pdf','cbz')),
  generation TEXT NOT NULL,
  size_bytes TEXT NOT NULL,
  metadata TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  section INTEGER NOT NULL DEFAULT 0,
  fraction REAL NOT NULL DEFAULT 0
);
-- A previous scanner skipped books, including in saved partial scans.
UPDATE sync_checkpoints SET state='idle',token=NULL,counts='{}' WHERE id='library';
