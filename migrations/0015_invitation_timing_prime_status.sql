ALTER TABLE extension_feedback
  ADD COLUMN prime_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (prime_status IN ('prime', 'non_prime', 'unknown'));
ALTER TABLE extension_feedback ADD COLUMN invitation_remaining_seconds INTEGER;
ALTER TABLE extension_feedback ADD COLUMN invitation_expires_at INTEGER;
ALTER TABLE extension_feedback ADD COLUMN invitation_granted_at_estimated INTEGER;

ALTER TABLE feedback_hourly
  ADD COLUMN prime_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (prime_status IN ('prime', 'non_prime', 'unknown'));
ALTER TABLE feedback_hourly ADD COLUMN invitation_remaining_seconds INTEGER;
ALTER TABLE feedback_hourly ADD COLUMN invitation_expires_at INTEGER;
ALTER TABLE feedback_hourly ADD COLUMN invitation_granted_at_estimated INTEGER;

ALTER TABLE scan_completions_hourly
  ADD COLUMN prime_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (prime_status IN ('prime', 'non_prime', 'unknown'));
