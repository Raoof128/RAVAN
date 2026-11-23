-- Screens approved before this grant existed keep their existing permissions.
ALTER TABLE devices ADD COLUMN reading INTEGER NOT NULL DEFAULT 0 CHECK(reading IN (0,1));
CREATE TABLE device_reader_sessions (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX device_reader_expiry ON device_reader_sessions(device_id, expires_at DESC);
-- All revocation paths, including uncollected pairings, invalidate browser access.
CREATE TRIGGER revoke_reader_access AFTER UPDATE OF revoked_at,reading ON devices
WHEN NEW.revoked_at IS NOT NULL OR NEW.reading=0
BEGIN
  DELETE FROM device_reader_sessions WHERE device_id=NEW.id;
END;
