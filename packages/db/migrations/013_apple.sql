CREATE TABLE server_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT UNIQUE NOT NULL);
INSERT INTO server_identity VALUES (1, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-8' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))));
ALTER TABLE devices ADD COLUMN watchlist_write INTEGER NOT NULL DEFAULT 0 CHECK(watchlist_write IN (0,1));
ALTER TABLE playback_sessions ADD COLUMN edition_id TEXT;
-- Older sessions name the source. Attribute them only when it identifies one cut.
UPDATE playback_sessions AS ps SET edition_id=(
  SELECT min(e.id) FROM editions e WHERE e.source_id=ps.source_id AND e.movie_id=ps.movie_id HAVING count(*)=1
);
-- Progress predates edition selection. Preserve unattributed legacy rows.
CREATE TABLE progress_editions (
  movie_id TEXT PRIMARY KEY REFERENCES movies(id) ON DELETE CASCADE,
  edition_id TEXT NOT NULL, generation TEXT NOT NULL
);
INSERT INTO progress_editions
SELECT p.movie_id, ps.edition_id, ps.generation FROM progress p
JOIN playback_sessions ps ON ps.id=p.session_id AND ps.movie_id=p.movie_id
WHERE ps.edition_id IS NOT NULL;
CREATE INDEX progress_recency ON progress(updated_at DESC, movie_id);
-- A request tracks successive jobs and is readable only by its initiating principal.
CREATE TABLE native_preparations (
  id TEXT PRIMARY KEY, principal TEXT NOT NULL, movie_id TEXT NOT NULL,
  edition_id TEXT NOT NULL, source_id TEXT NOT NULL, generation TEXT NOT NULL,
  options TEXT NOT NULL, job_id TEXT NOT NULL, direct INTEGER NOT NULL DEFAULT 0,
  failure TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX native_preparation_job ON native_preparations(job_id);
