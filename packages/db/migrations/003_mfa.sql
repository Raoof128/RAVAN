CREATE TABLE owner_mfa(subject TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, last_counter INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE mfa_challenges(token_hash TEXT PRIMARY KEY, subject TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('enroll','verify','replace')), ciphertext TEXT);
CREATE INDEX mfa_expiry ON mfa_challenges(expires_at);
CREATE TABLE mfa_limits(subject TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mfa_recovery(subject TEXT NOT NULL, code_hash TEXT NOT NULL, PRIMARY KEY(subject,code_hash));
-- Credentials minted before mandatory MFA must never survive this upgrade.
DELETE FROM web_sessions;
UPDATE devices SET revoked_at=unixepoch()*1000 WHERE revoked_at IS NULL;
UPDATE playback_sessions SET revoked_at=unixepoch()*1000 WHERE revoked_at IS NULL;
DELETE FROM pairing_requests;
