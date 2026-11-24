-- Keep acknowledgement independent of the short-lived exchange. Older paired
-- devices whose exchange has already been cleaned up retain their access.
ALTER TABLE devices ADD COLUMN pairing_request_id TEXT;
ALTER TABLE devices ADD COLUMN awaiting_ack INTEGER NOT NULL DEFAULT 0 CHECK(awaiting_ack IN (0,1));
UPDATE devices SET pairing_request_id=p.id, awaiting_ack=(p.state='approved')
FROM pairing_requests p WHERE p.device_id=devices.id;
-- Before this migration the minute to collect and acknowledge started at
-- owner approval. Close already-expired approvals even between cleanup runs.
UPDATE devices SET revoked_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
WHERE awaiting_ack=1 AND revoked_at IS NULL AND pairing_request_id IN (
  SELECT id FROM pairing_requests
  WHERE delivered_at IS NULL OR delivered_at+60000<=unixepoch('subsec')*1000
);
