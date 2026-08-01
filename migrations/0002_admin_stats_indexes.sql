CREATE INDEX IF NOT EXISTS idx_feedback_received_at
  ON extension_feedback(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_extension_credentials_scope_created
  ON extension_credentials(scope, created_at DESC, instance_id);

CREATE INDEX IF NOT EXISTS idx_extension_auth_activity_last_seen
  ON extension_auth_activity(last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_observations_received_at
  ON observations(received_at DESC);
