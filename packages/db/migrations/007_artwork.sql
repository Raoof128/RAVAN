ALTER TABLE artwork ADD COLUMN kind TEXT NOT NULL DEFAULT 'poster';
ALTER TABLE artwork ADD COLUMN generation TEXT NOT NULL DEFAULT '';
ALTER TABLE artwork ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX artwork_movie ON artwork(movie_id,kind);
CREATE TABLE artwork_lookups(movie_id TEXT PRIMARY KEY REFERENCES movies(id), tried_at INTEGER NOT NULL, outcome TEXT NOT NULL);
