ALTER TABLE invitation_waves ADD COLUMN detected_at INTEGER;

UPDATE invitation_waves
   SET detected_at = started_at
 WHERE detected_at IS NULL;
