CREATE TABLE media_ticket_grace(ticket_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES playback_sessions(id), expires_at INTEGER NOT NULL);
CREATE INDEX media_ticket_expiry ON media_ticket_grace(expires_at);
