CREATE TABLE IF NOT EXISTS scan_completions_hourly (
  hour              INTEGER NOT NULL,
  instance_id       TEXT NOT NULL,
  run_kind          TEXT NOT NULL CHECK (run_kind IN ('full', 'partial')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('completed', 'blocked', 'cancelled', 'failed')),
  successful        INTEGER NOT NULL DEFAULT 0,
  extension_version TEXT NOT NULL DEFAULT '',
  checked           INTEGER NOT NULL,
  expected          INTEGER NOT NULL,
  errors            INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  completed_at      INTEGER NOT NULL,
  duration_ms       INTEGER NOT NULL,
  PRIMARY KEY (hour, instance_id, run_kind)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_scan_completions_hourly_summary
  ON scan_completions_hourly(hour, run_kind, successful);
