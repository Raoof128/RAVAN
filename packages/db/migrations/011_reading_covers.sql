-- A book's shelf picture, made by the worker from the book (or none found),
-- for the generation it was made from. Files live in the artwork directory.
CREATE TABLE reading_covers(
  item_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  picture_id TEXT UNIQUE,
  path TEXT,
  created_at INTEGER NOT NULL
);
