CREATE TABLE IF NOT EXISTS extension_credentials (
  credential_id TEXT PRIMARY KEY,
  secret        TEXT NOT NULL,
  scope         TEXT NOT NULL CHECK (scope IN ('instance', 'observations')),
  instance_id   TEXT,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_extension_credentials_instance
  ON extension_credentials(instance_id, scope, revoked);

CREATE INDEX IF NOT EXISTS idx_extension_credentials_expiry
  ON extension_credentials(expires_at, revoked);

CREATE TABLE IF NOT EXISTS extension_auth_activity (
  instance_id  TEXT PRIMARY KEY,
  auth_version INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_extension_auth_activity_rollout
  ON extension_auth_activity(auth_version, last_seen DESC);
