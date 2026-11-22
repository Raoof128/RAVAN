-- A film's title follows its Drive file name, so a rename in Drive shows in
-- RAVAN, until the owner edits the title in RAVAN; then it is theirs.
ALTER TABLE movies ADD COLUMN title_edited INTEGER NOT NULL DEFAULT 0 CHECK(title_edited IN(0,1));
-- An edit in RAVAN stamped updated_at in milliseconds; an import's default is
-- in seconds. Titles edited before this release stay the owner's.
UPDATE movies SET title_edited=1 WHERE updated_at>100000000000;
-- Renames Drive reported before this release: the scans that saw them kept
-- the old titles, and the unattended schedule looks again only when Drive
-- changes. Apply the rule now: a film with one source, its title never
-- edited, takes its file name without the extension (as a scan does).
CREATE TEMP TABLE renamed AS
SELECT m.id, CASE
    WHEN instr(s.name, '.') > 0 AND substr(s.name, -1) <> '.'
    THEN substr(rtrim(s.name, replace(s.name, '.', '')), 1,
                length(rtrim(s.name, replace(s.name, '.', ''))) - 1)
    ELSE s.name END AS title
FROM movies m JOIN source_files s ON s.movie_id = m.id AND s.available = 1
WHERE m.title_edited = 0
  AND (SELECT count(*) FROM source_files o WHERE o.movie_id = m.id AND o.available = 1) = 1;
DELETE FROM renamed WHERE title = '' OR title = (SELECT title FROM movies WHERE id = renamed.id);
-- A new name deserves another look for a poster, as in a scan.
DELETE FROM artwork_lookups WHERE outcome <> 'found' AND movie_id IN (SELECT id FROM renamed);
UPDATE movies SET title = (SELECT title FROM renamed WHERE renamed.id = movies.id)
WHERE id IN (SELECT id FROM renamed);
DROP TABLE renamed;
