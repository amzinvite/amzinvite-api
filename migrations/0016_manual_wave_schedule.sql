CREATE TABLE IF NOT EXISTS manual_wave_schedule (
  id TEXT PRIMARY KEY,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT 'Vague exceptionnelle',
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_manual_wave_schedule_active
  ON manual_wave_schedule(active, starts_at, ends_at);
