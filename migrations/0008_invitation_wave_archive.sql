CREATE TABLE IF NOT EXISTS invitation_waves (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL UNIQUE,
  ended_at INTEGER NOT NULL,
  finalized_at INTEGER NOT NULL,
  installations INTEGER NOT NULL,
  active_users INTEGER NOT NULL,
  selected_users INTEGER NOT NULL,
  validations INTEGER NOT NULL,
  products INTEGER NOT NULL,
  selection_rate REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invitation_wave_products (
  wave_id TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  asin TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  selected_users INTEGER NOT NULL,
  validations INTEGER NOT NULL,
  eligible_users INTEGER NOT NULL,
  selection_rate REAL NOT NULL,
  PRIMARY KEY (wave_id, marketplace, asin),
  FOREIGN KEY (wave_id) REFERENCES invitation_waves(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invitation_waves_started
  ON invitation_waves(started_at DESC);
