CREATE TABLE library_folders(id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT);
CREATE INDEX library_folders_parent ON library_folders(parent_id);
CREATE INDEX source_parent ON source_files(parent_id);
