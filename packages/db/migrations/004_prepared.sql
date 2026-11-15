CREATE TABLE prepared_assets(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,generation TEXT NOT NULL,quality TEXT NOT NULL,audio_track INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'queued',size_bytes TEXT NOT NULL DEFAULT '0',subtitles TEXT NOT NULL DEFAULT '[]',label TEXT NOT NULL DEFAULT '',last_used INTEGER NOT NULL);
CREATE INDEX prepared_source ON prepared_assets(source_id,generation);
ALTER TABLE jobs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
ALTER TABLE playback_sessions ADD COLUMN asset_id TEXT;
ALTER TABLE playback_sessions ADD COLUMN label TEXT NOT NULL DEFAULT 'Original';
